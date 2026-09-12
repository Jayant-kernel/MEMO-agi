import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"

const stateFile = (directory) => join(resolve(directory), ".memo", "workspace.json")
const now = () => new Date().toISOString()
const emptyWorkspace = () => ({ schema_version: 1, projects: [], chats: [] })

const assertText = (value, label, maxLength) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new Error(`${label} must be non-empty and no longer than ${maxLength} characters.`)
  }
  return value.trim()
}

const assertID = (value, label) => {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{2,79}$/i.test(value)) throw new Error(`${label} is invalid.`)
  return value
}

const readWorkspace = async (directory) => {
  try {
    const workspace = JSON.parse(await readFile(stateFile(directory), "utf8"))
    if (workspace.schema_version !== 1 || !Array.isArray(workspace.projects) || !Array.isArray(workspace.chats)) throw new Error("Workspace data is invalid.")
    return workspace
  } catch (error) {
    if (error.code === "ENOENT") return emptyWorkspace()
    throw error
  }
}

const writeWorkspace = async (directory, workspace) => {
  const file = stateFile(directory)
  await mkdir(resolve(directory, ".memo"), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(workspace, null, 2)}\n`, "utf8")
  await rename(temporary, file)
}

const projectPath = (directory, value) => {
  const root = resolve(directory)
  const candidate = resolve(root, assertText(value, "project path", 1000))
  const pathFromRoot = relative(root, candidate)
  if (pathFromRoot.startsWith("..") || pathFromRoot === "..") throw new Error("Project path must be inside the Memo root.")
  return candidate
}

export const getWorkspace = async (directory) => readWorkspace(directory)

export const createProject = async (directory, input) => {
  const workspace = await readWorkspace(directory)
  const name = assertText(input.name, "project name", 120)
  const root = projectPath(directory, input.path ?? ".")
  if (workspace.projects.some((project) => project.root.toLowerCase() === root.toLowerCase())) throw new Error("A project already uses this path.")
  const project = { id: `project-${randomUUID()}`, name, root, created_at: now() }
  workspace.projects.push(project)
  await writeWorkspace(directory, workspace)
  return project
}

export const createChat = async (directory, input) => {
  const workspace = await readWorkspace(directory)
  const projectID = assertID(input.project_id, "project_id")
  if (!workspace.projects.some((project) => project.id === projectID)) throw new Error("Project does not exist.")
  const timestamp = now()
  const chat = { id: `chat-${randomUUID()}`, project_id: projectID, title: assertText(input.title, "chat title", 160), created_at: timestamp, updated_at: timestamp, messages: [] }
  workspace.chats.push(chat)
  await writeWorkspace(directory, workspace)
  return chat
}

export const addMessage = async (directory, input) => {
  const workspace = await readWorkspace(directory)
  const chatID = assertID(input.chat_id, "chat_id")
  const chat = workspace.chats.find((candidate) => candidate.id === chatID)
  if (!chat) throw new Error("Chat does not exist.")
  const role = input.role ?? "user"
  if (!new Set(["user", "assistant", "system"]).has(role)) throw new Error("Message role is invalid.")
  const message = { id: `message-${randomUUID()}`, role, content: assertText(input.content, "message content", 8000), created_at: now() }
  chat.messages.push(message)
  chat.updated_at = message.created_at
  await writeWorkspace(directory, workspace)
  return message
}
