import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createChat, createProject, getWorkspace, setChatExecution } from "../app/workspace.mjs"
import { MemoBridge } from "../app/bridge.mjs"
import { createMemoServer } from "../app/server.mjs"
import { MemoEvents } from "../app/events.mjs"
import { safeEvent } from "../app/opencode-adapter.mjs"

const withWorkspace = async (callback) => {
  const directory = await mkdtemp(join(tmpdir(), "memo-phase4-"))
  try { await callback(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

const setup = async (directory) => {
  const project = await createProject(directory, { name: "Memo", path: "." })
  const chat = await createChat(directory, { project_id: project.id, title: "Phase 4" })
  return { project, chat }
}

test("high-risk approval is server-owned and content-bound", async () => withWorkspace(async (directory) => {
  const calls = []
  const bridge = new MemoBridge({ createSession: async () => "session-supervised", prompt: async (input) => { calls.push(input); return { text: "Reviewed.", upstream_message_id: "assistant-supervised" } } })
  const { chat } = await setup(directory)
  const run = await bridge.start(directory, { chat_id: chat.id, content: "Delete customer data from production.", high_risk_approved: true })
  assert.equal(run.status, "awaiting_supervision")
  assert.equal(run.route, "codex-supervisor")
  assert.equal(calls.length, 0)
  await assert.rejects(() => bridge.approve(directory, run.id, { content: "Different request" }), /does not match/)
  await bridge.approve(directory, run.id, { content: "Delete customer data from production.", content_hash: run.content_hash, approval_nonce: run.approval_nonce })
  await bridge.running.get(run.id)
  assert.equal(calls[0].route, "codex-supervisor")
}))

test("links manifest before run, chooses frontier, and persists session before prompt", async () => withWorkspace(async (directory) => {
  const observations = []
  const { project, chat } = await setup(directory)
  const bridge = new MemoBridge({
    createSession: async () => "session-ordered",
    prompt: async (input) => {
      observations.push({ input, workspace: await getWorkspace(directory) })
      return { text: "Complete.", upstream_message_id: "assistant-ordered" }
    },
  })
  const result = await bridge.run(directory, { chat_id: chat.id, content: "Explain the test.", approved: true })
  const runFile = JSON.parse(await readFile(join(project.root, ".memo", "runs", `${result.id}.json`), "utf8"))
  assert.equal(runFile.task_id, result.task_id)
  assert.equal(observations[0].input.route, "frontier-orchestrator")
  assert.equal(observations[0].workspace.chats[0].session_id, "session-ordered")
}))

test("rejects concurrent runs and cancels an active adapter session", async () => withWorkspace(async (directory) => {
  let releasePrompt
  let aborted = false
  const pendingPrompt = new Promise((resolve) => { releasePrompt = resolve })
  const bridge = new MemoBridge({ createSession: async () => "session-stop", prompt: async () => pendingPrompt, abort: async () => { aborted = true } })
  const { chat } = await setup(directory)
  const run = await bridge.start(directory, { chat_id: chat.id, content: "Do ordinary work." })
  await assert.rejects(() => bridge.start(directory, { chat_id: chat.id, content: "Second request." }), { message: /active run/, statusCode: 409 })
  for (let attempt = 0; attempt < 100 && !(await bridge.get(directory, run.id)).session_id; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal((await bridge.get(directory, run.id)).session_id, "session-stop")
  const stopped = await bridge.stop(directory, run.id)
  assert.equal(stopped.status, "cancelled")
  releasePrompt({ text: "Too late." })
  await bridge.running.get(run.id)
  assert.equal(aborted, true)
}))

test("run endpoints require JSON and expose lifecycle status", async () => withWorkspace(async (directory) => {
  const { chat } = await setup(directory)
  let releasePrompt
  const pendingPrompt = new Promise((resolve) => { releasePrompt = resolve })
  const bridge = new MemoBridge({ createSession: async () => "session-http", prompt: async () => pendingPrompt, abort: async () => releasePrompt({ text: "Stopped." }) })
  const server = createMemoServer(directory, { bridge })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}`
    const bad = await fetch(`${url}/api/chats/${chat.id}/runs`, { method: "POST", body: "{}" })
    assert.equal(bad.status, 400)
    const created = await fetch(`${url}/api/chats/${chat.id}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Do ordinary work." }) })
    assert.equal(created.status, 202)
    const run = await created.json()
    const fetched = await fetch(`${url}/api/runs/${run.id}`)
    assert.equal(fetched.status, 200)
    const duplicate = await fetch(`${url}/api/chats/${chat.id}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Again." }) })
    assert.equal(duplicate.status, 409)
    const stopped = await fetch(`${url}/api/runs/${run.id}/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    assert.equal(stopped.status, 202)
    await bridge.running.get(run.id)
  } finally { await new Promise((resolve) => server.close(resolve)) }
}))

test("starts without an upstream, returns structured 503, and keeps oversized JSON readable", async () => withWorkspace(async (directory) => {
  const { chat } = await setup(directory)
  const previous = process.env.MEMO_OPENCODE_URL
  delete process.env.MEMO_OPENCODE_URL
  const server = createMemoServer(directory)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}`
    const unavailable = await fetch(`${url}/api/chats/${chat.id}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Do local work." }) })
    assert.equal(unavailable.status, 202)
    const unavailableRun = await unavailable.json()
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const current = await (await fetch(`${url}/api/runs/${unavailableRun.id}`)).json()
      if (current.status === "failed") break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal((await (await fetch(`${url}/api/runs/${unavailableRun.id}`)).json()).status, "failed")
    const tooLongContent = await fetch(`${url}/api/chats/${chat.id}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "x".repeat(8001) }) })
    assert.equal(tooLongContent.status, 400)
    const tooLarge = await fetch(`${url}/api/chats/${chat.id}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "x".repeat(65536) }) })
    assert.equal(tooLarge.status, 413)
    assert.equal((await tooLarge.json()).code, "REQUEST_TOO_LARGE")
    const page = await fetch(url)
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/)
  } finally {
    if (previous === undefined) delete process.env.MEMO_OPENCODE_URL
    else process.env.MEMO_OPENCODE_URL = previous
    await new Promise((resolve) => server.close(resolve))
  }
}))

test("SSE validates chats and replays bounded safe lifecycle events", async () => withWorkspace(async (directory) => {
  const { chat } = await setup(directory)
  const events = new MemoEvents({ limit: 2, heartbeatMs: 1000 })
  events.publish(chat.id, { type: "status", run_id: "run-replay", status: "pending" })
  events.publish(chat.id, { type: "status", run_id: "run-replay", status: "running" })
  events.publish(chat.id, { type: "status", run_id: "run-replay", status: "completed" })
  assert.equal(events.publish(chat.id, { type: "raw", run_id: "run-replay", payload: "unsafe" }), false)
  const server = createMemoServer(directory, { bridge: new MemoBridge({}), events })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}`
    assert.equal((await fetch(`${url}/api/chats/chat-missing/events`)).status, 404)
    const stream = await fetch(`${url}/api/chats/${chat.id}/events`, { headers: { "last-event-id": "1" } })
    const reader = stream.body.getReader()
    const chunk = await reader.read()
    const body = new TextDecoder().decode(chunk.value)
    assert.match(body, /id: 2/)
    assert.match(body, /"running"/)
    assert.match(body, /id: 3/)
    assert.match(body, /"completed"/)
    await reader.cancel()
  } finally { await new Promise((resolve) => server.close(resolve)) }
}))

test("retry does not duplicate the user message and resume uses the saved session", async () => withWorkspace(async (directory) => {
  const { chat } = await setup(directory)
  let prompts = 0
  let listed = 0
  const bridge = new MemoBridge({
    createSession: async () => "session-retry",
    prompt: async () => { prompts += 1; if (prompts === 1) throw new Error("temporary failure"); return { text: "Recovered.", upstream_message_id: "assistant-recovered" } },
    listMessages: async () => { listed += 1; return [] },
  })
  const first = await bridge.start(directory, { chat_id: chat.id, content: "Try this." })
  await assert.rejects(() => bridge.running.get(first.id), /temporary failure/)
  const retried = await bridge.retry(directory, first.id)
  await bridge.running.get(retried.id)
  const workspace = await getWorkspace(directory)
  assert.deepEqual(workspace.chats[0].messages.map((message) => message.role), ["user", "assistant"])
  await bridge.resume(directory, chat.id)
  assert.equal(listed, 1)
}))

test("resume deduplicates all upstream message roles and restart keeps supervision pending", async () => withWorkspace(async (directory) => {
  const { chat } = await setup(directory)
  const bridge = new MemoBridge({
    listMessages: async () => [
      { role: "user", content: "Remote request", upstream_message_id: "upstream-user" },
      { role: "assistant", content: "Remote answer", upstream_message_id: "upstream-assistant" },
    ],
  })
  await setChatExecution(directory, { chat_id: chat.id, session_id: "session-resume", status: "idle" })
  await bridge.resume(directory, chat.id)
  await bridge.resume(directory, chat.id)
  const workspace = await getWorkspace(directory)
  assert.deepEqual(workspace.chats[0].messages.map((message) => message.content), ["Remote request", "Remote answer"])
  const supervised = await bridge.start(directory, { chat_id: chat.id, content: "Delete production data." })
  await bridge.reconcile(directory)
  assert.equal((await bridge.get(directory, supervised.id)).status, "awaiting_supervision")
}))

test("permission replies use persisted upstream permission IDs and do not support remembered rejection", async () => withWorkspace(async (directory) => {
  const { chat } = await setup(directory)
  const replies = []
  const bridge = new MemoBridge({
    createSession: async () => "session-permission",
    prompt: async () => new Promise(() => {}),
    replyPermission: async (input) => { replies.push(input) },
  })
  const run = await bridge.start(directory, { chat_id: chat.id, content: "Check the project status." })
  for (let attempt = 0; attempt < 20 && !(await bridge.get(directory, run.id)).session_id; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  await bridge.handleAdapterEvent(directory, run.id, { type: "permission.requested", session_id: "session-permission", permission_id: "permission-one", title: "Read a file", operation_type: "read", target: "README.md" })
  await bridge.replyPermission(directory, run.id, { permission_id: "permission-one", response: "once" })
  await bridge.handleAdapterEvent(directory, run.id, { type: "permission.requested", session_id: "session-permission", permission_id: "permission-two", title: "Run a command", operation_type: "bash", target: "npm test" })
  await bridge.replyPermission(directory, run.id, { permission_id: "permission-two", response: "reject" })
  await assert.rejects(() => bridge.replyPermission(directory, run.id, { permission_id: "permission-three", response: "reject_remember" }), /invalid|awaiting/)
  assert.deepEqual(replies.map(({ permission_id, response }) => ({ permission_id, response })), [{ permission_id: "permission-one", response: "once" }, { permission_id: "permission-two", response: "reject" }])
  const file = join(directory, ".memo", "workspace.json")
  const valid = JSON.parse(await readFile(file, "utf8"))
  valid.pending_permissions.push(structuredClone(valid.pending_permissions[0]))
  await writeFile(file, JSON.stringify(valid))
  await assert.rejects(() => getWorkspace(directory), /duplicate permission IDs/)
  valid.pending_permissions.pop()
  await writeFile(file, JSON.stringify(valid))
  await bridge.stop(directory, run.id)
}))

test("multiple permissions resolve sequentially, retain run ownership, and emit lifecycle events", async () => withWorkspace(async (directory) => {
  const { chat } = await setup(directory)
  const replies = [], emitted = []
  const bridge = new MemoBridge({ createSession: async () => "session-owner", prompt: async () => new Promise(() => {}), replyPermission: async (input) => replies.push(input) })
  const run = await bridge.start(directory, { chat_id: chat.id, content: "Inspect local files." }, (event) => emitted.push(event))
  for (let attempt = 0; attempt < 20 && !(await bridge.get(directory, run.id)).session_id; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  await bridge.handleAdapterEvent(directory, run.id, { type: "permission.requested", session_id: "session-owner", permission_id: "permission-first", title: "Read first", operation_type: "read", target: "first.txt" }, (event) => emitted.push(event))
  await bridge.handleAdapterEvent(directory, run.id, { type: "permission.requested", session_id: "session-owner", permission_id: "permission-second", title: "Read second", operation_type: "read", target: "second.txt" }, (event) => emitted.push(event))
  assert.equal((await bridge.get(directory, run.id)).status, "awaiting_permission")
  await bridge.handleAdapterEvent(directory, run.id, { type: "permission.requested", session_id: "session-other", permission_id: "permission-cross", title: "Other", operation_type: "read", target: "other.txt" }, (event) => emitted.push(event))
  assert.equal((await getWorkspace(directory)).pending_permissions.length, 2)
  await bridge.replyPermission(directory, run.id, { permission_id: "permission-first", response: "once" }, (event) => emitted.push(event))
  assert.equal((await bridge.get(directory, run.id)).status, "awaiting_permission")
  await bridge.replyPermission(directory, run.id, { permission_id: "permission-second", response: "reject" }, (event) => emitted.push(event))
  assert.equal((await bridge.get(directory, run.id)).status, "running")
  assert.deepEqual(replies.map(({ session_id, permission_id, response }) => ({ session_id, permission_id, response })), [{ session_id: "session-owner", permission_id: "permission-first", response: "once" }, { session_id: "session-owner", permission_id: "permission-second", response: "reject" }])
  assert.equal(emitted.filter((event) => event.type === "permission.requested").length, 2)
  assert.deepEqual(emitted.filter((event) => event.type === "permission.resolved").map((event) => event.permission_id), ["permission-first", "permission-second"])
  await bridge.stop(directory, run.id)
}))

test("risk endpoint enforces content bounds and returns server-classified routes", async () => withWorkspace(async (directory) => {
  const server = createMemoServer(directory, { bridge: new MemoBridge({}) })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/risk`
    for (const content of ["", " ", "x".repeat(8001)]) {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) })
      assert.equal(response.status, 400)
    }
    const ordinary = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Summarize this project." }) })).json()
    const highRisk = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Delete production customer data." }) })).json()
    assert.deepEqual(ordinary, { route: "frontier-orchestrator", risk_categories: [], requires_approval: false })
    assert.deepEqual(highRisk, { route: "codex-supervisor", risk_categories: ["destructive-data"], requires_approval: true })
  } finally { await new Promise((resolve) => server.close(resolve)) }
}))

test("approval retrieval and cancellation use the server-owned approval record", async () => withWorkspace(async (directory) => {
  const { chat } = await setup(directory)
  const bridge = new MemoBridge({ ensureAvailable: () => {}, createSession: async () => "session-unused", prompt: async () => ({ text: "unused" }) })
  const server = createMemoServer(directory, { bridge })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}`
    const created = await fetch(`${url}/api/chats/${chat.id}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Delete production data." }) })
    const run = await created.json()
    const approval = await fetch(`${url}/api/runs/${run.id}/approval`)
    assert.equal(approval.status, 200)
    const approvalBody = await approval.json()
    assert.equal(approvalBody.content, "Delete production data.")
    assert.deepEqual(approvalBody.risk_categories, ["destructive-data"])
    assert.equal(approvalBody.required_route, "codex-supervisor")
    assert.equal("session_id" in approvalBody, false)
    assert.equal("path" in approvalBody, false)
    const cancelled = await fetch(`${url}/api/runs/${run.id}/approval/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    assert.equal(cancelled.status, 202)
    assert.equal((await cancelled.json()).status, "cancelled")
  } finally { await new Promise((resolve) => server.close(resolve)) }
}))

test("workspace DTO hides session IDs and adapter event mapping rejects malformed data", async () => withWorkspace(async (directory) => {
  const { chat } = await setup(directory)
  await setChatExecution(directory, { chat_id: chat.id, session_id: "session-private", status: "idle" })
  const server = createMemoServer(directory, { bridge: new MemoBridge({}) })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const workspace = await (await fetch(`http://127.0.0.1:${server.address().port}/api/workspace`)).json()
    assert.equal(workspace.chats[0].has_session, true)
    assert.equal("session_id" in workspace.chats[0], false)
  } finally { await new Promise((resolve) => server.close(resolve)) }
  assert.deepEqual(safeEvent({ type: "permission.updated", properties: { sessionID: "session-private", messageID: "upstream-message", id: "permission-ok", title: "Read file", type: "read", pattern: "README.md" } }, "session-private"), { type: "permission.requested", session_id: "session-private", message_id: "upstream-message", permission_id: "permission-ok", title: "Read file", operation_type: "read", target: "README.md" })
  assert.equal(safeEvent({ type: "permission.updated", properties: { sessionID: "session-private", id: "", title: "Read file" } }, "session-private"), null)
  assert.equal(safeEvent({ type: "session.idle", properties: { sessionID: "other" } }, "session-private"), null)
}))
