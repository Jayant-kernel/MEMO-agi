import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addMessage, createChat, createProject, getWorkspace } from "../app/workspace.mjs"
import { MemoBridge } from "../app/bridge.mjs"

const withWorkspace = async (callback) => {
  const directory = await mkdtemp(join(tmpdir(), "memo-workspace-"))
  try { await callback(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

test("persists an isolated project chat and message", async () => withWorkspace(async (directory) => {
  const project = await createProject(directory, { name: "Memo", path: "." })
  const chat = await createChat(directory, { project_id: project.id, title: "First task" })
  const message = await addMessage(directory, { chat_id: chat.id, content: "Build the workspace." })
  const workspace = await getWorkspace(directory)
  assert.equal(workspace.projects[0].root, directory)
  assert.equal(workspace.chats[0].messages[0].id, message.id)
  assert.equal(workspace.chats[0].messages[0].role, "user")
}))

test("rejects project escape paths and chats without an owner", async () => withWorkspace(async (directory) => {
  await assert.rejects(() => createProject(directory, { name: "Outside", path: ".." }), /inside the Memo root/)
  await writeFile(join(directory, "not-a-directory.txt"), "x")
  await assert.rejects(() => createProject(directory, { name: "File", path: "not-a-directory.txt" }), /must be a directory/)
  await assert.rejects(() => createChat(directory, { project_id: "project-missing", title: "No owner" }), /does not exist/)
}))

test("rejects messages for unknown chats", async () => withWorkspace(async (directory) => {
  await assert.rejects(() => addMessage(directory, { chat_id: "chat-missing", content: "No target" }), /does not exist/)
}))

test("preserves every concurrent message write", async () => withWorkspace(async (directory) => {
  const project = await createProject(directory, { name: "Memo", path: "." })
  const chat = await createChat(directory, { project_id: project.id, title: "Concurrent work" })
  await Promise.all(Array.from({ length: 20 }, (_, index) => addMessage(directory, { chat_id: chat.id, content: `Message ${index}` })))
  const workspace = await getWorkspace(directory)
  assert.equal(workspace.chats[0].messages.length, 20)
  assert.equal(new Set(workspace.chats[0].messages.map((message) => message.content)).size, 20)
}))

test("migrates baseline chats before validation and persists normalized state on mutation", async () => withWorkspace(async (directory) => {
  const timestamp = new Date().toISOString()
  await mkdir(join(directory, ".memo"), { recursive: true })
  await writeFile(join(directory, ".memo", "workspace.json"), JSON.stringify({
    schema_version: 1,
    projects: [{ id: "project-legacy", name: "Legacy", root: directory, created_at: timestamp }],
    chats: [{ id: "chat-legacy", project_id: "project-legacy", title: "Legacy chat", created_at: timestamp, updated_at: timestamp, messages: [{ id: "message-legacy", role: "user", content: "Existing message", created_at: timestamp }] }],
  }))

  const migrated = await getWorkspace(directory)
  assert.deepEqual({ session_id: migrated.chats[0].session_id, active_run_id: migrated.chats[0].active_run_id, run_status: migrated.chats[0].run_status, last_error: migrated.chats[0].last_error }, { session_id: null, active_run_id: null, run_status: null, last_error: null })
  assert.equal(migrated.chats[0].messages[0].upstream_message_id, null)

  await addMessage(directory, { chat_id: "chat-legacy", content: "New message" })
  const persisted = JSON.parse(await readFile(join(directory, ".memo", "workspace.json"), "utf8"))
  assert.equal(persisted.chats[0].active_run_id, null)
  assert.equal(persisted.chats[0].messages[0].upstream_message_id, null)
  assert.deepEqual(persisted.runs, [])
  assert.deepEqual(persisted.pending_permissions, [])
}))

test("records an approved fake OpenCode response and session", async () => withWorkspace(async (directory) => {
  const project = await createProject(directory, { name: "Memo", path: "." })
  const chat = await createChat(directory, { project_id: project.id, title: "Bridge" })
  const bridge = new MemoBridge({ createSession: async () => "session-fake", prompt: async () => ({ text: "Verified response.", upstream_message_id: "upstream-assistant-fake" }) })
  const result = await bridge.run(directory, { chat_id: chat.id, content: "Explain the test.", approved: true })
  const workspace = await getWorkspace(directory)
  assert.equal(result.session_id, "session-fake")
  assert.equal(workspace.chats[0].execution.session_id, "session-fake")
  assert.deepEqual(workspace.chats[0].messages.map((message) => message.role), ["user", "assistant"])
}))

test("requires approval before the bridge calls an adapter", async () => withWorkspace(async (directory) => {
  const project = await createProject(directory, { name: "Memo", path: "." })
  const chat = await createChat(directory, { project_id: project.id, title: "Approval" })
  const bridge = new MemoBridge({ run: async () => { throw new Error("must not run") } })
  await assert.rejects(() => bridge.run(directory, { chat_id: chat.id, content: "Do work." }), /Explicit approval/)
}))

test("persists the final upstream assistant message ID", async () => withWorkspace(async (directory) => {
  const project = await createProject(directory, { name: "Memo", path: "." })
  const chat = await createChat(directory, { project_id: project.id, title: "Upstream IDs" })
  const bridge = new MemoBridge({ createSession: async () => "session-upstream", prompt: async () => ({ text: "Remote response.", upstream_message_id: "upstream-assistant-final" }) })
  const run = await bridge.start(directory, { chat_id: chat.id, content: "Get response." })
  await bridge.running.get(run.id)
  const workspace = await getWorkspace(directory)
  assert.equal(workspace.chats[0].messages.at(-1).upstream_message_id, "upstream-assistant-final")
}))
