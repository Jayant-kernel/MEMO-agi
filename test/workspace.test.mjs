import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addMessage, createChat, createProject, getWorkspace } from "../app/workspace.mjs"

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
  await assert.rejects(() => createChat(directory, { project_id: "project-missing", title: "No owner" }), /does not exist/)
}))

test("rejects messages for unknown chats", async () => withWorkspace(async (directory) => {
  await assert.rejects(() => addMessage(directory, { chat_id: "chat-missing", content: "No target" }), /does not exist/)
}))
