import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { fork } from "node:child_process"
import { createServer as createHTTPServer } from "node:http"
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { addMessage, completeChatRun, createChat, createProject, getWorkspace } from "../app/workspace.mjs"
import { createManifest, createRun, finishRun, getMemoState } from "../.opencode/lib/memo-state.mjs"
import { MemoBridge } from "../app/bridge.mjs"
import { MemoEvents } from "../app/events.mjs"
import { OpenCodeAdapter, safeEvent } from "../app/opencode-adapter.mjs"
import { createMemoServer } from "../app/server.mjs"

const withWorkspace = async (callback) => {
  const directory = await mkdtemp(join(tmpdir(), "memo-corrections-"))
  try { await callback(directory) } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) }
}
const setup = async (directory) => {
  const project = await createProject(directory, { name: "Memo", path: "." })
  const chat = await createChat(directory, { project_id: project.id, title: "Corrections" })
  return { project, chat }
}
const startLockChild = async (directory) => {
  const child = fork(new URL("./fixtures/server-lock-child.mjs", import.meta.url), [directory], { stdio: ["ignore", "ignore", "ignore", "ipc"] })
  await new Promise((resolve, reject) => {
    child.once("message", (message) => message?.type === "ready" ? resolve() : reject(new Error("Child server did not become ready.")))
    child.once("error", reject)
    child.once("exit", (code) => reject(new Error(`Child server exited before ready (${code}).`)))
  })
  return child
}
const stopLockChild = async (child) => {
  if (!child) return
  if (child.exitCode !== null) return
  await new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGTERM") })
}

test("8000 characters execute and 8001 characters have no run, message, ledger, or adapter effects", async () => withWorkspace(async (directory) => {
  const { chat } = await setup(directory)
  const calls = []
  const bridge = new MemoBridge({ createSession: async () => { calls.push("session"); return "session-length" }, prompt: async () => { calls.push("prompt"); return { text: "ok", upstream_message_id: "assistant-length" } } })
  const accepted = await bridge.start(directory, { chat_id: chat.id, content: "x".repeat(8000) })
  await bridge.running.get(accepted.id)
  const before = await getWorkspace(directory)
  await assert.rejects(() => bridge.start(directory, { chat_id: chat.id, content: "x".repeat(8001) }), /8000/)
  const after = await getWorkspace(directory)
  assert.equal(after.runs.length, before.runs.length)
  assert.equal(after.chats[0].messages.length, before.chats[0].messages.length)
  assert.deepEqual(calls, ["session", "prompt"])
}))

test("manifest, ledger, and message initialization failures fail locally without adapter calls", async () => {
  for (const failure of ["manifest", "ledger", "message"]) await withWorkspace(async (directory) => {
    const { project, chat } = await setup(directory)
    let adapterCalls = 0
    const state = {
      createManifest: failure === "manifest" ? async () => { throw new Error("manifest failed") } : createManifest,
      createRun: failure === "ledger" ? async () => { throw new Error("ledger failed") } : createRun,
      addMessage: failure === "message" ? async () => { throw new Error("message failed") } : addMessage,
    }
    const bridge = new MemoBridge({ createSession: async () => { adapterCalls += 1; return "session-never" }, prompt: async () => { adapterCalls += 1 } }, state)
    await assert.rejects(() => bridge.start(directory, { chat_id: chat.id, content: "Initialize safely." }), new RegExp(`${failure} failed`))
    const workspace = await getWorkspace(directory)
    assert.equal(workspace.runs[0].status, "failed")
    assert.equal(workspace.chats[0].active_run_id, null)
    assert.equal(adapterCalls, 0)
    if (failure === "message") {
      const ledger = JSON.parse(await readFile(join(project.root, ".memo", "runs", `${workspace.runs[0].id}.json`), "utf8"))
      assert.equal(ledger.status, "failed")
    }
  })
})

test("two sequential prompts reuse one session and persist both upstream identities", async () => withWorkspace(async (directory) => {
  const { chat } = await setup(directory)
  let sessions = 0, prompts = 0
  const bridge = new MemoBridge({
    createSession: async () => { sessions += 1; return "session-reused" },
    prompt: async (input) => { prompts += 1; return { text: `answer ${prompts}`, user_upstream_message_id: input.user_message_id, upstream_message_id: `assistant-${prompts}` } },
  })
  const first = await bridge.start(directory, { chat_id: chat.id, content: "First prompt." }); await bridge.running.get(first.id)
  const second = await bridge.start(directory, { chat_id: chat.id, content: "Second prompt." }); await bridge.running.get(second.id)
  const messages = (await getWorkspace(directory)).chats[0].messages
  assert.equal(sessions, 1); assert.equal(prompts, 2)
  assert.equal(messages.filter((message) => message.role === "user" && message.upstream_message_id).length, 2)
  assert.equal(messages.filter((message) => message.role === "user").every((message) => message.upstream_message_id.startsWith("msg-")), true)
  assert.deepEqual(messages.filter((message) => message.role === "assistant").map((message) => message.upstream_message_id), ["assistant-1", "assistant-2"])
}))

test("completed session resume is idempotent with execution-assigned upstream IDs", async () => withWorkspace(async (directory) => {
  const { chat } = await setup(directory)
  const remote = []
  const bridge = new MemoBridge({
    createSession: async () => "session-resume-completed",
    prompt: async (input) => {
      const number = remote.length / 2 + 1
      remote.push(
        { role: "user", content: input.content, upstream_message_id: input.user_message_id },
        { role: "assistant", content: `answer ${number}`, upstream_message_id: `assistant-resume-${number}` },
      )
      return { text: `answer ${number}`, user_upstream_message_id: input.user_message_id, upstream_message_id: `assistant-resume-${number}` }
    },
    listMessages: async () => remote,
  })
  const first = await bridge.start(directory, { chat_id: chat.id, content: "First prompt." }); await bridge.running.get(first.id)
  const second = await bridge.start(directory, { chat_id: chat.id, content: "Second prompt." }); await bridge.running.get(second.id)
  const before = (await getWorkspace(directory)).chats[0].messages.length
  await bridge.resume(directory, chat.id)
  await bridge.resume(directory, chat.id)
  assert.equal((await getWorkspace(directory)).chats[0].messages.length, before)
}))

test("adapter ignores stale idle and unrelated events, correlates tools, and closes its iterator", async () => {
  let release, returned = false, submitted
  const gate = new Promise((resolve) => { release = resolve })
  const stream = (async function * () {
    try {
      yield { type: "session.idle", properties: { sessionID: "session-one" } }
      await gate
      yield { type: "message.updated", properties: { info: { id: "assistant-current", sessionID: "session-one", role: "assistant", parentID: "user-current" } } }
      yield { type: "message.part.updated", properties: { part: { type: "text", sessionID: "session-one", messageID: "assistant-other" }, delta: "stale" } }
      yield { type: "message.part.updated", properties: { part: { type: "tool", sessionID: "session-one", messageID: "assistant-current", callID: "call-one", tool: "read", state: { status: "running", title: "README.md" } } } }
      yield { type: "session.idle", properties: { sessionID: "session-one" } }
    } finally { returned = true }
  })()
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1")
  adapter.client = async () => ({
    event: { subscribe: async () => ({ stream }) },
    session: {
      promptAsync: async ({ body }) => { submitted = body; release() },
      messages: async () => ({ data: [{ info: { id: "assistant-current", role: "assistant", parentID: "user-current" }, parts: [{ type: "text", text: "current answer" }] }] }),
    },
  })
  const observed = []
  const result = await adapter.prompt({ project_root: ".", session_id: "session-one", user_message_id: "user-current", content: "hello", route: "agent", onEvent: (event) => observed.push(event) })
  assert.equal(submitted.messageID, "user-current")
  assert.equal(result.upstream_message_id, "assistant-current")
  assert.equal(observed.some((event) => event.type === "assistant.delta"), false)
  assert.equal(observed.some((event) => event.type === "tool.started"), true)
  assert.equal(returned, true)
})

test("adapter authenticates local status checks without exposing credentials", async () => {
  const expected = `Basic ${Buffer.from("memo-user:memo-password").toString("base64")}`
  const server = createHTTPServer((request, response) => {
    response.statusCode = request.headers.authorization === expected ? 200 : 401
    response.setHeader("x-opencode-version", "test-auth")
    response.end()
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const baseURL = `http://127.0.0.1:${server.address().port}`
    assert.deepEqual(await new OpenCodeAdapter(baseURL).status(), { configured: true, reachable: false, version: "test-auth" })
    assert.deepEqual(await new OpenCodeAdapter(baseURL, { username: "memo-user", password: "memo-password" }).status(), { configured: true, reachable: true, version: "test-auth" })
    assert.throws(() => new OpenCodeAdapter(baseURL, { username: "memo-user" }), /configured together/)
  } finally { await new Promise((resolve) => server.close(resolve)) }
})

test("adapter prompt rejection aborts consumption and requests iterator cleanup", async () => {
  let returned = false
  const iterator = { next: () => new Promise(() => {}), return: async () => { returned = true; return { done: true } } }
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1")
  adapter.client = async () => ({ event: { subscribe: async () => ({ stream: { [Symbol.asyncIterator]: () => iterator } }) }, session: { promptAsync: async () => { throw new Error("prompt rejected") } } })
  await assert.rejects(() => adapter.prompt({ project_root: ".", session_id: "session-one", user_message_id: "user-current", content: "hello", route: "agent" }), /prompt rejected/)
  assert.equal(returned, true)
})

test("adapter rejects subscription failures, premature streams, and correlated session errors without unhandled rejections", async () => {
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  try {
    const rejected = new OpenCodeAdapter("http://127.0.0.1:1")
    rejected.client = async () => ({ event: { subscribe: async () => { throw new Error("subscription rejected") } }, session: {} })
    await assert.rejects(() => rejected.prompt({ project_root: ".", session_id: "session-subscription", user_message_id: "user-subscription", content: "hello", route: "agent" }), /subscription rejected/)
    assert.equal(rejected.activePrompts.size, 0)

    let streamReturned = false
    const ended = new OpenCodeAdapter("http://127.0.0.1:1")
    ended.client = async () => ({ event: { subscribe: async () => ({ stream: { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true }), return: async () => { streamReturned = true; return { done: true } } }) } }) }, session: { promptAsync: async () => {} } })
    await assert.rejects(() => ended.prompt({ project_root: ".", session_id: "session-ended", user_message_id: "user-ended", content: "hello", route: "agent" }), /ended before/)
    assert.equal(streamReturned, true)
    assert.equal(ended.activePrompts.size, 0)

    let errorReturned = false
    const errored = new OpenCodeAdapter("http://127.0.0.1:1")
    errored.client = async () => ({
      event: { subscribe: async () => ({ stream: { [Symbol.asyncIterator]: async function * () { try { yield { type: "message.updated", properties: { info: { id: "assistant-error", sessionID: "session-error", role: "assistant", parentID: "user-error" } } }; yield { type: "session.error", properties: { sessionID: "session-error" } } } finally { errorReturned = true } } } }) },
      session: { promptAsync: async () => {} },
    })
    await assert.rejects(() => errored.prompt({ project_root: ".", session_id: "session-error", user_message_id: "user-error", content: "hello", route: "agent" }), /session error/)
    assert.equal(errorReturned, true)
    assert.equal(errored.activePrompts.size, 0)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(unhandled, [])
  } finally { process.off("unhandledRejection", onUnhandled) }
})

test("adapter aborts an active prompt and closes its iterator without unhandled rejections", async () => {
  let returned = false, aborted = false, releasePrompt
  const prompt = new Promise((resolve) => { releasePrompt = resolve })
  const iterator = { next: () => new Promise(() => {}), return: async () => { returned = true; return { done: true } } }
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1")
  adapter.client = async () => ({ event: { subscribe: async () => ({ stream: { [Symbol.asyncIterator]: () => iterator } }) }, session: { promptAsync: async () => prompt, abort: async () => { aborted = true; releasePrompt() } } })
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  try {
    const pending = adapter.prompt({ project_root: ".", session_id: "session-abort", user_message_id: "user-abort", content: "hello", route: "agent" })
    await new Promise((resolve) => setImmediate(resolve))
    await adapter.abort({ project_root: ".", session_id: "session-abort" })
    await assert.rejects(() => pending, /aborted/)
    assert.equal(aborted, true)
    assert.equal(returned, true)
    assert.equal(adapter.activePrompts.size, 0)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(unhandled, [])
  } finally { process.off("unhandledRejection", onUnhandled) }
})

test("safe adapter mappings sanitize tools and reject malformed or cross-session events", () => {
  assert.deepEqual(safeEvent({ type: "message.part.updated", properties: { part: { type: "tool", sessionID: "session-one", messageID: "message-one", callID: "call-one", tool: "bash", state: { status: "completed", title: "npm test" } } } }, "session-one"), { type: "tool.completed", session_id: "session-one", message_id: "message-one", call_id: "call-one", operation_type: "bash", target: "npm test" })
  const sanitized = safeEvent({ type: "permission.updated", properties: { sessionID: "session-one", messageID: "message-one", id: "permission-one", title: "Run", type: "bad operation!", pattern: "x\nsecret" } }, "session-one")
  assert.equal(sanitized.operation_type, "operation"); assert.equal(sanitized.target, null)
  assert.equal(safeEvent({ type: "session.idle", properties: { sessionID: "session-other" } }, "session-one"), null)
  assert.equal(safeEvent({ type: "unknown", properties: { sessionID: "session-one" } }, "session-one"), null)
  assert.equal(safeEvent({ type: "permission.replied", properties: { sessionID: "session-one", permissionID: "permission-one", response: "always" } }, "session-one"), null)
  assert.equal(safeEvent({ type: "permission.updated", properties: { sessionID: "session-one", messageID: "message-one", id: "permission-one", title: "Run\nsecret", type: "bash" } }, "session-one"), null)
})

test("whitespace deltas remain valid but mismatched prompt identities fail", async () => withWorkspace(async (directory) => {
  const { chat } = await setup(directory)
  const bridge = new MemoBridge({
    createSession: async () => "session-mismatch",
    prompt: async (input) => {
      await input.onEvent({ type: "assistant.delta", session_id: input.session_id, content: " " })
      return { text: "wrong", user_upstream_message_id: "user-other", upstream_message_id: "assistant-wrong" }
    },
  })
  const emitted = []
  const run = await bridge.start(directory, { chat_id: chat.id, content: "Correlate this response." }, (event) => emitted.push(event))
  await assert.rejects(() => bridge.running.get(run.id), /current prompt/)
  assert.equal(emitted.some((event) => event.type === "assistant.delta" && event.content === " "), true)
  assert.equal((await bridge.get(directory, run.id)).status, "failed")
}))

test("SSE chat capacity rejects with 429 without evicting an active listener", () => {
  const events = new MemoEvents({ chatLimit: 1, listenerLimit: 1, ttlMs: 60000 })
  const request = new EventEmitter(), response = new EventEmitter()
  response.writableEnded = false; response.writeHead = () => {}; response.write = () => true; response.end = () => { response.writableEnded = true }
  assert.equal(events.subscribe("chat-one", request, response), true)
  const rejected = new EventEmitter(); rejected.writeHead = (status) => { rejected.status = status }; rejected.end = () => {}
  assert.equal(events.subscribe("chat-two", new EventEmitter(), rejected), false)
  assert.equal(rejected.status, 429); assert.equal(events.chats.has("chat-one"), true)
  request.emit("close")
})

test("SSE preserves the stable dotted lifecycle event contract", () => {
  const events = new MemoEvents()
  assert.equal(events.publish("chat-events", { type: "assistant.delta", run_id: "run-events", content: " " }), true)
  assert.equal(events.publish("chat-events", { type: "tool.started", run_id: "run-events", operation_type: "read", target: "README.md" }), true)
  assert.equal(events.publish("chat-events", { type: "tool.completed", run_id: "run-events", operation_type: "read", target: "README.md", secret: "hidden" }), true)
  assert.equal(events.publish("chat-events", { type: "permission.requested", run_id: "run-events", permission_id: "permission-one", title: "Read", operation_type: "read", target: "README.md", session_id: "hidden" }), true)
  assert.equal(events.publish("chat-events", { type: "permission.resolved", run_id: "run-events", permission_id: "permission-one", response: "once", internal: "hidden" }), true)
  const replay = events.chats.get("chat-events").runs.get("run-events").map((entry) => entry.event)
  assert.deepEqual(replay.map((event) => event.type), ["assistant.delta", "tool.started", "tool.completed", "permission.requested", "permission.resolved"])
  assert.deepEqual(Object.keys(replay[2]).sort(), ["chat_id", "operation_type", "run_id", "target", "type"])
  assert.deepEqual(Object.keys(replay[3]).sort(), ["chat_id", "operation_type", "permission_id", "run_id", "target", "title", "type"])
  assert.deepEqual(Object.keys(replay[4]).sort(), ["chat_id", "permission_id", "response", "run_id", "type"])
})

test("HTTP event-capacity rejection creates no run or message", async () => withWorkspace(async (directory) => {
  const project = await createProject(directory, { name: "Memo", path: "." })
  const first = await createChat(directory, { project_id: project.id, title: "First" })
  const second = await createChat(directory, { project_id: project.id, title: "Second" })
  const events = new MemoEvents({ chatLimit: 1, listenerLimit: 1, ttlMs: 60000 })
  const requestStream = new EventEmitter(), responseStream = new EventEmitter()
  responseStream.writableEnded = false; responseStream.writeHead = () => {}; responseStream.write = () => true; responseStream.end = () => { responseStream.writableEnded = true }
  events.subscribe(first.id, requestStream, responseStream)
  const server = createMemoServer(directory, { bridge: new MemoBridge({}), events })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chats/${second.id}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Do ordinary work." }) })
    assert.equal(response.status, 429)
    const workspace = await getWorkspace(directory)
    assert.equal(workspace.runs.length, 0)
    assert.equal(workspace.chats.find((chat) => chat.id === second.id).messages.length, 0)
  } finally {
    requestStream.emit("close")
    await new Promise((resolve) => server.close(resolve))
  }
}))

test("workspace browsing does not instantiate the adapter and status does", async () => withWorkspace(async (directory) => {
  await setup(directory)
  let constructions = 0
  const server = createMemoServer(directory, { adapterFactory: () => { constructions += 1; return { status: async () => ({ configured: false, reachable: false, version: null, secret: "hidden" }) } } })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}`
    assert.equal((await fetch(`${url}/api/workspace`)).status, 200); assert.equal(constructions, 0)
    const status = await fetch(`${url}/api/opencode/status`)
    assert.equal(status.status, 200); assert.equal(constructions, 1)
    assert.deepEqual(await status.json(), { configured: false, reachable: false, version: null })
  } finally { await new Promise((resolve) => server.close(resolve)) }
}))

test("listen failure releases the workspace server lock for retry", async () => withWorkspace(async (directory) => {
  const occupied = createHTTPServer()
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve))
  const failed = createMemoServer(directory, { bridge: new MemoBridge({}) })
  await new Promise((resolve) => { failed.once("error", resolve); failed.listen(occupied.address().port, "127.0.0.1") })
  await new Promise((resolve) => occupied.close(resolve))
  const retried = createMemoServer(directory, { bridge: new MemoBridge({}) })
  await new Promise((resolve) => retried.listen(0, "127.0.0.1", resolve))
  await new Promise((resolve) => retried.close(resolve))
}))

test("server construction failure does not poison the process registry or lock", async () => withWorkspace(async (directory) => {
  const options = { get events() { throw new Error("construction failed") } }
  assert.throws(() => createMemoServer(directory, options), /construction failed/)
  const retried = createMemoServer(directory, { bridge: new MemoBridge({}) })
  await new Promise((resolve) => retried.listen(0, "127.0.0.1", resolve))
  await new Promise((resolve) => retried.close(resolve))
}))

test("approval persists truthful evidence and excludes the nonce from the ledger", async () => withWorkspace(async (directory) => {
  const { project, chat } = await setup(directory)
  const bridge = new MemoBridge({ createSession: async () => "session-approved", prompt: async () => ({ text: "reviewed", upstream_message_id: "assistant-approved" }) })
  const run = await bridge.start(directory, { chat_id: chat.id, content: "Fix authentication concurrency." })
  const approved = await bridge.approve(directory, run.id, { content: run.content, content_hash: run.content_hash, approval_nonce: run.approval_nonce })
  await bridge.running.get(run.id)
  assert.equal(approved.approval_type, "user")
  assert.equal(approved.approved_content_hash, run.content_hash)
  assert.ok(approved.approved_at)
  assert.deepEqual(approved.risk_categories, ["authentication", "concurrency"])
  const events = await readFile(join(project.root, ".memo", "runs", `${run.id}.events.jsonl`), "utf8")
  const approval = events.trim().split("\n").map(JSON.parse).find((event) => event.type === "approval")
  assert.equal(approval.evidence[0].approval_type, "user")
  assert.equal("approval_nonce" in approval.evidence[0], false)
  assert.equal(approval.evidence[0].required_route, "codex-supervisor")
}))

test("persisted workspace validation rejects unsafe ownership and lifecycle relationships", async () => withWorkspace(async (directory) => {
  const { chat } = await setup(directory)
  const bridge = new MemoBridge({})
  const run = await bridge.start(directory, { chat_id: chat.id, content: "Delete production data." })
  const file = join(directory, ".memo", "workspace.json")
  const valid = JSON.parse(await readFile(file, "utf8"))
  const cases = [
    (workspace) => { workspace.projects[0].root = tmpdir() },
    (workspace) => { workspace.chats[0].title = "" },
    (workspace) => { workspace.chats[0].active_run_id = "run-missing" },
    (workspace) => { workspace.chats[0].active_run_id = null },
    (workspace) => { workspace.chats[0].run_status = "running" },
    (workspace) => { workspace.runs[0].completed_at = new Date().toISOString() },
    (workspace) => { workspace.runs[0].user_message_id = "message-missing" },
    (workspace) => { workspace.runs[0].approved_content_hash = workspace.runs[0].content_hash },
  ]
  for (const corrupt of cases) {
    const workspace = structuredClone(valid); corrupt(workspace)
    await writeFile(file, JSON.stringify(workspace))
    await assert.rejects(() => getWorkspace(directory), /Workspace/)
  }
  await writeFile(file, JSON.stringify(valid))
  await bridge.stop(directory, run.id)
}))

test("dead stale locks recover while live locks remain authoritative regardless of age", async () => withWorkspace(async (directory) => {
  const memo = join(directory, ".memo"), lock = join(memo, "server.lock")
  await mkdir(memo, { recursive: true })
  await writeFile(lock, JSON.stringify({ pid: 2147483647, token: "dead" }))
  const old = new Date(Date.now() - 5000); await utimes(lock, old, old)
  const recovered = createMemoServer(directory, { bridge: new MemoBridge({}) }); await new Promise((resolve) => recovered.listen(0, "127.0.0.1", resolve)); await new Promise((resolve) => recovered.close(resolve))
  await writeFile(lock, JSON.stringify({ pid: process.pid, token: "reused", process_started_at: 1 })); await utimes(lock, old, old)
  const identityRecovered = createMemoServer(directory, { bridge: new MemoBridge({}) }); await new Promise((resolve) => identityRecovered.listen(0, "127.0.0.1", resolve)); await new Promise((resolve) => identityRecovered.close(resolve))
  await writeFile(lock, JSON.stringify({ pid: process.pid, token: "live" })); await utimes(lock, old, old)
  assert.throws(() => createMemoServer(directory, { bridge: new MemoBridge({}) }), (error) => error.code === "MEMO_SERVER_LOCKED")
  await rm(lock, { force: true })
}))

test("cross-process server locks preserve live owners and recover a dead stale owner", async () => withWorkspace(async (directory) => {
  const lock = join(directory, ".memo", "server.lock")
  let child
  try {
    child = await startLockChild(directory)
    assert.throws(() => createMemoServer(directory, { bridge: new MemoBridge({}) }), (error) => error.code === "MEMO_SERVER_LOCKED")
    const old = new Date(Date.now() - 5000)
    await utimes(lock, old, old)
    assert.throws(() => createMemoServer(directory, { bridge: new MemoBridge({}) }), (error) => error.code === "MEMO_SERVER_LOCKED")
    await new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGKILL") })
    child = null
    await utimes(lock, old, old)
    const recovered = createMemoServer(directory, { bridge: new MemoBridge({}) })
    await new Promise((resolve) => recovered.listen(0, "127.0.0.1", resolve))
    await new Promise((resolve) => recovered.close(resolve))
  } finally { await stopLockChild(child) }
}))

test("restart reconciliation converges completion regardless of which durable store finished first", async () => {
  await withWorkspace(async (directory) => {
    const { project, chat } = await setup(directory)
    const bridge = new MemoBridge({ createSession: async () => "session-ledger-first", prompt: async () => new Promise(() => {}) })
    const run = await bridge.start(directory, { chat_id: chat.id, content: "Complete ledger first." })
    for (let attempt = 0; attempt < 300 && (await bridge.get(directory, run.id)).status !== "running"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal((await bridge.get(directory, run.id)).status, "running")
    await addMessage(directory, { chat_id: chat.id, role: "assistant", content: "Persisted response.", upstream_message_id: "assistant-ledger-first" })
    await finishRun(project.root, { run_id: run.id, status: "passed", outcome: "OpenCode response recorded." })

    await new MemoBridge({}).reconcile(directory)
    assert.equal((await bridge.get(directory, run.id)).status, "completed")
  })

  await withWorkspace(async (directory) => {
    const { project, chat } = await setup(directory)
    const bridge = new MemoBridge({ createSession: async () => "session-workspace-first", prompt: async () => new Promise(() => {}) })
    const run = await bridge.start(directory, { chat_id: chat.id, content: "Complete workspace first." })
    for (let attempt = 0; attempt < 300 && (await bridge.get(directory, run.id)).status !== "running"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal((await bridge.get(directory, run.id)).status, "running")
    await completeChatRun(directory, { run_id: run.id, content: "Persisted response.", upstream_message_id: "assistant-workspace-first" })

    await new MemoBridge({}).reconcile(directory)
    assert.equal((await getMemoState(project.root, { run_id: run.id })).status, "passed")
  })

  await withWorkspace(async (directory) => {
    const { project, chat } = await setup(directory)
    const bridge = new MemoBridge({ createSession: async () => "session-no-response", prompt: async () => new Promise(() => {}) })
    const run = await bridge.start(directory, { chat_id: chat.id, content: "Do not invent a response." })
    for (let attempt = 0; attempt < 300 && (await bridge.get(directory, run.id)).status !== "running"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal((await bridge.get(directory, run.id)).status, "running")
    await finishRun(project.root, { run_id: run.id, status: "passed", outcome: "Incorrectly finalized without a response." })

    await new MemoBridge({}).reconcile(directory)
    const reconciled = await bridge.get(directory, run.id)
    assert.equal(reconciled.status, "failed")
    assert.match(reconciled.last_error, /without a persisted assistant response/)
  })
})

test("reconciliation does not overwrite a completed workspace from a contradictory terminal ledger", async () => withWorkspace(async (directory) => {
  const { project, chat } = await setup(directory)
  const bridge = new MemoBridge({ createSession: async () => "session-terminal-conflict", prompt: async () => ({ text: "Persisted response.", upstream_message_id: "assistant-terminal-conflict" }) })
  const run = await bridge.start(directory, { chat_id: chat.id, content: "Complete this run." })
  await bridge.running.get(run.id)
  const path = join(project.root, ".memo", "runs", `${run.id}.json`)
  const ledger = JSON.parse(await readFile(path, "utf8")); ledger.status = "failed"; ledger.outcome = "Contradictory terminal state."
  await writeFile(path, JSON.stringify(ledger))

  await new MemoBridge({}).reconcile(directory)
  assert.equal((await bridge.get(directory, run.id)).status, "completed")
}))

test("stopping a supervision-pending run releases transient bridge state", async () => withWorkspace(async (directory) => {
  const { chat } = await setup(directory)
  const bridge = new MemoBridge({})
  const run = await bridge.start(directory, { chat_id: chat.id, content: "Delete production data." })
  assert.equal(run.status, "awaiting_supervision")
  await bridge.stop(directory, run.id)
  assert.equal(bridge.stopping.has(run.id), false)
}))

test("a run can retry after cancellation during session creation", async () => withWorkspace(async (directory) => {
  const { chat } = await setup(directory)
  let releaseSession, releasePrompt, sessionCalls = 0, failPrompt = false
  const bridge = new MemoBridge({
    createSession: async () => { sessionCalls += 1; return sessionCalls === 1 ? new Promise((resolve) => { releaseSession = resolve }) : "session-retry-after-stop" },
    prompt: async () => { if (failPrompt) throw new Error("expected retry failure"); return new Promise((resolve) => { releasePrompt = resolve }) },
  })
  const first = await bridge.start(directory, { chat_id: chat.id, content: "Wait for setup." })
  for (let attempt = 0; attempt < 100 && !releaseSession; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  await bridge.stop(directory, first.id)
  releaseSession("session-cancelled")

  failPrompt = true
  const failedRetry = await bridge.retry(directory, first.id)
  await assert.rejects(() => bridge.running.get(failedRetry.id), /expected retry failure/)
  failPrompt = false
  const runningRetry = await bridge.retry(directory, failedRetry.id)
  for (let attempt = 0; attempt < 100 && (await bridge.get(directory, runningRetry.id)).status !== "running"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal((await bridge.get(directory, runningRetry.id)).status, "running")
  await bridge.stop(directory, runningRetry.id)
  releasePrompt?.({ text: "Stopped.", upstream_message_id: "assistant-stopped-retry" })
  await bridge.running.get(runningRetry.id)
}))
