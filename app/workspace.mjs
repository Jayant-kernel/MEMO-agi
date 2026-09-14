import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"

const stateFile = (directory) => join(resolve(directory), ".memo", "workspace.json")
const lockFile = (directory) => join(resolve(directory), ".memo", "workspace.lock")
export const MAX_REQUEST_CHARS = 8000
export const MAX_HTTP_BODY_BYTES = 65536
export const MAX_WORKSPACE_ITEMS = 1000
const now = () => new Date().toISOString()
const replaceFile = async (temporary, file) => {
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(temporary, file); return }
    catch (error) { if (!new Set(["EPERM", "EACCES"]).has(error.code) || attempt >= 10) throw error; await new Promise((resolveDelay) => setTimeout(resolveDelay, 10 * (attempt + 1))) }
  }
}
const RUN_STATUSES = new Set(["pending", "awaiting_supervision", "running", "awaiting_permission", "completed", "failed", "cancelled"])
const activeStatuses = new Set(["pending", "awaiting_supervision", "running", "awaiting_permission"])
const transitions = {
  awaiting_supervision: new Set(["pending", "failed", "cancelled"]), pending: new Set(["running", "failed", "cancelled"]),
  running: new Set(["awaiting_permission", "completed", "failed", "cancelled"]),
  awaiting_permission: new Set(["running", "failed", "cancelled"]), completed: new Set(), failed: new Set(), cancelled: new Set(),
}
const emptyWorkspace = () => ({ schema_version: 1, projects: [], chats: [], runs: [], pending_permissions: [] })
const writeQueues = new Map()
const processStartedAt = Date.now() - Math.round(process.uptime() * 1000)

const assertText = (value, label, maxLength = MAX_REQUEST_CHARS) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new Error(`${label} must be non-empty and no longer than ${maxLength} characters.`)
  }
  return value.trim()
}

const assertID = (value, label) => {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{2,79}$/i.test(value)) throw new Error(`${label} is invalid.`)
  return value
}

const assertArray = (value, label) => { if (!Array.isArray(value)) throw new Error(`Workspace ${label} is invalid.`) }
const assertTimestamp = (value, label) => { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`Workspace ${label} is invalid.`) }
const pathInside = (root, candidate) => {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${String.fromCharCode(92)}`) && !pathFromRoot.startsWith("../")
}
const validateWorkspace = async (directory, workspace) => {
  if (!workspace || workspace.schema_version !== 1 || typeof workspace !== "object") throw new Error("Workspace data is invalid.")
  for (const key of ["projects", "chats", "runs", "pending_permissions"]) assertArray(workspace[key], key)
  for (const key of ["projects", "chats", "runs", "pending_permissions"]) if (workspace[key].length > MAX_WORKSPACE_ITEMS) throw new Error(`Workspace ${key} exceeds its limit.`)
  const projects = new Set()
  const memoRoot = await realpath(resolve(directory))
  for (const project of workspace.projects) {
    assertID(project?.id, "project id"); assertText(project?.name, "project name", 120); assertText(project?.root, "project root", 1000); assertTimestamp(project?.created_at, "project created_at")
    if (projects.has(project.id)) throw new Error("Workspace has duplicate project IDs.")
    let canonical
    try { canonical = await realpath(project.root) } catch { throw new Error("Workspace project root must be an existing directory.") }
    if (!(await stat(canonical)).isDirectory() || !pathInside(memoRoot, canonical) || canonical !== project.root) throw new Error("Workspace project root is invalid.")
    projects.add(project.id)
  }
  const chats = new Set(), messageOwners = new Map()
  for (const chat of workspace.chats) {
    assertID(chat?.id, "chat id"); assertID(chat?.project_id, "project_id"); assertText(chat?.title, "chat title", 160); assertArray(chat?.messages, "chat messages"); assertTimestamp(chat?.created_at, "chat created_at"); assertTimestamp(chat?.updated_at, "chat updated_at")
    if (chat.session_id !== null && chat.session_id !== undefined) assertText(chat.session_id, "session_id", 200)
    if (!projects.has(chat.project_id) || chats.has(chat.id)) throw new Error("Workspace chat references are invalid.")
    chats.add(chat.id)
    if (chat.messages.length > MAX_WORKSPACE_ITEMS) throw new Error("Workspace chat messages exceeds its limit.")
    const messageIDs = new Set(), upstreamMessageIDs = new Set()
    for (const message of chat.messages) {
      assertID(message?.id, "message id"); if (messageIDs.has(message.id) || messageOwners.has(message.id)) throw new Error("Workspace has duplicate message IDs."); messageIDs.add(message.id); messageOwners.set(message.id, { chat_id: chat.id, role: message.role })
      if (!new Set(["user", "assistant", "system"]).has(message?.role)) throw new Error("Workspace message role is invalid.")
      assertText(message?.content, "message content"); assertTimestamp(message?.created_at, "message created_at")
      if (message.upstream_message_id !== null && message.upstream_message_id !== undefined) { assertText(message.upstream_message_id, "upstream_message_id", 200); if (upstreamMessageIDs.has(message.upstream_message_id)) throw new Error("Workspace has duplicate upstream message IDs."); upstreamMessageIDs.add(message.upstream_message_id) }
    }
  }
  const runs = new Set(), runsByID = new Map()
  for (const run of workspace.runs) {
    assertID(run?.id, "run id"); assertID(run?.chat_id, "chat_id"); assertID(run?.task_id, "task_id"); assertText(run?.content, "run content"); assertText(run?.route, "run route", 100); assertTimestamp(run?.created_at, "run created_at"); assertTimestamp(run?.updated_at, "run updated_at")
    if (run.session_id !== null && run.session_id !== undefined) assertText(run.session_id, "run session_id", 200)
    if (run.user_message_id !== null && run.user_message_id !== undefined) assertID(run.user_message_id, "user_message_id")
    if (run.assistant_message_id !== null && run.assistant_message_id !== undefined) assertID(run.assistant_message_id, "assistant_message_id")
    if (run.user_message_id && (messageOwners.get(run.user_message_id)?.chat_id !== run.chat_id || messageOwners.get(run.user_message_id)?.role !== "user")) throw new Error("Workspace run user message reference is invalid.")
    if (run.assistant_message_id && (messageOwners.get(run.assistant_message_id)?.chat_id !== run.chat_id || messageOwners.get(run.assistant_message_id)?.role !== "assistant")) throw new Error("Workspace run assistant message reference is invalid.")
    if (!chats.has(run.chat_id) || !RUN_STATUSES.has(run.status) || runs.has(run.id)) throw new Error("Workspace run references are invalid.")
    if (activeStatuses.has(run.status) ? run.completed_at !== null : run.completed_at === null) throw new Error("Workspace run completion state is invalid.")
    if (run.completed_at !== null) assertTimestamp(run.completed_at, "run completed_at")
    if (run.approved_at !== null && run.approved_at !== undefined) { assertTimestamp(run.approved_at, "run approved_at"); if (run.approval_type !== "user" || run.approved_content_hash !== run.content_hash) throw new Error("Workspace approval evidence is invalid.") }
    else if (run.approval_type !== null || run.approved_content_hash !== null) throw new Error("Workspace approval evidence is invalid.")
    if (!Array.isArray(run.risk_categories) || run.risk_categories.some((item) => typeof item !== "string" || !item.trim())) throw new Error("Workspace risk categories are invalid.")
    assertText(run.required_route, "required_route", 100)
    runs.add(run.id); runsByID.set(run.id, run)
  }
  for (const chat of workspace.chats) {
    const active = chat.active_run_id === null ? null : runsByID.get(chat.active_run_id)
    const latest = workspace.runs.filter((run) => run.chat_id === chat.id).at(-1)
    const expectedActive = latest && activeStatuses.has(latest.status) ? latest : null
    if (active !== expectedActive || (active && active.chat_id !== chat.id)) throw new Error("Workspace active run reference is invalid.")
    if ((latest?.status ?? null) !== (chat.run_status ?? null) || (chat.run_state !== undefined && chat.run_state !== (chat.run_status ?? null))) throw new Error("Workspace chat run status is inconsistent.")
    if (latest && new Set(["running", "awaiting_permission"]).has(latest.status) && (!latest.session_id || latest.session_id !== chat.session_id)) throw new Error("Workspace chat session ownership is inconsistent.")
  }
  const permissionIDs = new Set()
  for (const permission of workspace.pending_permissions) {
    assertID(permission?.run_id, "run_id"); assertText(permission?.session_id, "permission session_id", 200); assertText(permission?.permission_id, "permission_id", 200); assertText(permission?.title, "permission title", 500); assertText(permission?.operation_type, "permission operation_type", 64); assertTimestamp(permission?.created_at, "permission created_at")
    if (!/^[a-z0-9_.:-]+$/i.test(permission.operation_type) || /[\u0000-\u001f\u007f]/.test(permission.permission_id) || /[\u0000-\u001f\u007f]/.test(permission.title)) throw new Error("Workspace permission fields are unsafe.")
    if (permission.target !== null) { assertText(permission.target, "permission target", 500); if (/[\u0000-\u001f\u007f]/.test(permission.target)) throw new Error("Workspace permission fields are unsafe.") }
    const run = runsByID.get(permission.run_id)
    if (!run || run.session_id !== permission.session_id) throw new Error("Workspace permission references are invalid.")
    const resolved = permission.resolved_at !== null
    if (resolved !== (permission.response !== null)) throw new Error("Workspace permission resolution is invalid.")
    if (resolved && !new Set(["once", "reject"]).has(permission.response)) throw new Error("Workspace permission response is invalid.")
    if (resolved) assertTimestamp(permission.resolved_at, "permission resolved_at")
    else if (run.status !== "awaiting_permission") throw new Error("Workspace pending permission run status is invalid.")
    const key = `${permission.session_id}:${permission.permission_id}`
    if (permissionIDs.has(key)) throw new Error("Workspace has duplicate permission IDs.")
    permissionIDs.add(key)
  }
  return workspace
}

const readWorkspace = async (directory) => {
  try {
    const workspace = JSON.parse(await readFile(stateFile(directory), "utf8"))
    if (!Array.isArray(workspace.runs)) workspace.runs = []
    if (!Array.isArray(workspace.pending_permissions)) workspace.pending_permissions = []
    if (Array.isArray(workspace.chats)) for (const chat of workspace.chats) {
      if (chat.session_id === undefined) chat.session_id = chat.execution?.session_id ?? null
      if (chat.active_run_id === undefined) chat.active_run_id = null
      if (chat.last_error === undefined) chat.last_error = null
      if (chat.run_status === undefined) chat.run_status = workspace.runs.filter((run) => run.chat_id === chat.id).at(-1)?.status ?? null
      if (chat.run_state === undefined) chat.run_state = chat.run_status
      if (Array.isArray(chat.messages)) for (const message of chat.messages) if (message.upstream_message_id === undefined) message.upstream_message_id = null
    }
    return await validateWorkspace(directory, workspace)
  } catch (error) {
    if (error.code === "ENOENT") return emptyWorkspace()
    if (error.message?.startsWith("Workspace ")) throw error
    throw new Error(`Workspace data is invalid: ${error.message}`, { cause: error })
  }
}

const writeWorkspace = async (directory, workspace) => {
  const file = stateFile(directory)
  await mkdir(resolve(directory, ".memo"), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(workspace, null, 2)}\n`, "utf8")
  await replaceFile(temporary, file)
}

const acquireLock = async (directory) => {
  await mkdir(resolve(directory, ".memo"), { recursive: true })
  const path = lockFile(directory), deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      const handle = await open(path, "wx")
      const token = randomUUID()
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, process_started_at: processStartedAt, created_at: Date.now() })) }
      catch (error) { await handle.close().catch(() => {}); await rm(path, { force: true }).catch(() => {}); throw error }
      return async () => { await handle.close(); try { const owner = JSON.parse(await readFile(path, "utf8")); if (owner.token === token) await rm(path, { force: true }) } catch (error) { if (error.code !== "ENOENT") throw error } }
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      try {
        const owner = JSON.parse(await readFile(path, "utf8"))
        let alive = Number.isInteger(owner.pid) && owner.pid > 0
        if (alive) try { process.kill(owner.pid, 0) } catch (ownerError) { alive = ownerError.code === "EPERM" }
        if (alive && owner.pid === process.pid && Number.isFinite(owner.process_started_at) && owner.process_started_at !== processStartedAt) alive = false
        if (!alive && Date.now() - (await stat(path)).mtimeMs > 1000) await rm(path, { force: true })
      } catch (staleError) { if (staleError.code === "ENOENT") continue; if (staleError instanceof SyntaxError && Date.now() - (await stat(path)).mtimeMs > 30000) await rm(path, { force: true }); else if (!(staleError instanceof SyntaxError)) throw staleError }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
    }
  }
  throw Object.assign(new Error("Workspace is busy; try again."), { statusCode: 503 })
}

// Serialize read-modify-write operations per workspace to avoid lost updates.
const mutateWorkspace = (directory, change) => {
  const key = resolve(directory)
  const previous = writeQueues.get(key) ?? Promise.resolve()
  const queued = previous.catch(() => {}).then(async () => {
    const release = await acquireLock(directory)
    try {
      const workspace = await readWorkspace(directory)
      const result = await change(workspace)
      await validateWorkspace(directory, workspace)
      await writeWorkspace(directory, workspace)
      return result
    } finally { await release() }
  })
  writeQueues.set(key, queued)
  queued.finally(() => {
    if (writeQueues.get(key) === queued) writeQueues.delete(key)
  }).catch(() => {})
  return queued
}

const projectPath = async (directory, value) => {
  const root = await realpath(resolve(directory))
  const candidate = resolve(root, assertText(value, "project path", 1000))
  let resolvedCandidate
  try { resolvedCandidate = await realpath(candidate) } catch { throw new Error("Project path must exist inside the Memo root.") }
  try { if (!(await stat(resolvedCandidate)).isDirectory()) throw new Error("Project path must be a directory.") } catch (error) { if (error.message === "Project path must be a directory.") throw error; throw new Error("Project path must be a directory.") }
  if (!pathInside(root, resolvedCandidate)) throw new Error("Project path must be inside the Memo root.")
  return resolvedCandidate
}

export const getWorkspace = async (directory) => readWorkspace(directory)
export const getPendingPermissions = async (directory, runID) => {
  assertID(runID, "run_id")
  return (await readWorkspace(directory)).pending_permissions.filter((item) => item.run_id === runID && !item.resolved_at)
}

export const createProject = async (directory, input) => {
  return mutateWorkspace(directory, async (workspace) => {
    const name = assertText(input.name, "project name", 120)
    const root = await projectPath(directory, input.path ?? ".")
    if (workspace.projects.some((project) => project.root.toLowerCase() === root.toLowerCase())) throw new Error("A project already uses this path.")
    const project = { id: `project-${randomUUID()}`, name, root, created_at: now() }
    workspace.projects.push(project)
    return project
  })
}

export const createChat = async (directory, input) => {
  return mutateWorkspace(directory, async (workspace) => {
    const projectID = assertID(input.project_id, "project_id")
    if (!workspace.projects.some((project) => project.id === projectID)) throw new Error("Project does not exist.")
    const timestamp = now()
    const chat = { id: `chat-${randomUUID()}`, project_id: projectID, title: assertText(input.title, "chat title", 160), session_id: null, active_run_id: null, last_error: null, run_status: null, created_at: timestamp, updated_at: timestamp, messages: [] }
    workspace.chats.push(chat)
    return chat
  })
}

export const addMessage = async (directory, input) => {
  return mutateWorkspace(directory, async (workspace) => {
    const chatID = assertID(input.chat_id, "chat_id")
    const chat = workspace.chats.find((candidate) => candidate.id === chatID)
    if (!chat) throw new Error("Chat does not exist.")
    const role = input.role ?? "user"
    if (!new Set(["user", "assistant", "system"]).has(role)) throw new Error("Message role is invalid.")
    const upstreamMessageID = input.upstream_message_id === undefined ? null : assertText(input.upstream_message_id, "upstream_message_id", 200)
    if (upstreamMessageID && chat.messages.some((item) => item.upstream_message_id === upstreamMessageID)) return chat.messages.find((item) => item.upstream_message_id === upstreamMessageID)
    const message = { id: `message-${randomUUID()}`, role, content: assertText(input.content, "message content"), upstream_message_id: upstreamMessageID, created_at: now() }
    chat.messages.push(message)
    chat.updated_at = message.created_at
    return message
  })
}

export const setMessageUpstreamID = async (directory, input) => mutateWorkspace(directory, async (workspace) => {
  const chat = workspace.chats.find((candidate) => candidate.id === assertID(input.chat_id, "chat_id"))
  if (!chat) throw new Error("Chat does not exist.")
  const message = chat.messages.find((candidate) => candidate.id === assertID(input.message_id, "message_id"))
  if (!message) throw new Error("Message does not exist.")
  const upstreamID = assertText(input.upstream_message_id, "upstream_message_id", 200)
  const duplicate = chat.messages.find((candidate) => candidate !== message && candidate.upstream_message_id === upstreamID)
  if (duplicate) throw new Error("Workspace has duplicate upstream message IDs.")
  message.upstream_message_id = upstreamID
  chat.updated_at = now()
  return message
})

export const setChatExecution = async (directory, input) => mutateWorkspace(directory, async (workspace) => {
  const chatID = assertID(input.chat_id, "chat_id")
  const chat = workspace.chats.find((candidate) => candidate.id === chatID)
  if (!chat) throw new Error("Chat does not exist.")
  const timestamp = now()
  chat.session_id = assertText(input.session_id, "session_id", 200)
  chat.execution = { session_id: chat.session_id, status: input.status, updated_at: timestamp }
  chat.updated_at = timestamp
  return chat.execution
})

export const createChatRun = async (directory, input) => mutateWorkspace(directory, async (workspace) => {
  const chatID = assertID(input.chat_id, "chat_id")
  const chat = workspace.chats.find((candidate) => candidate.id === chatID)
  if (!chat) throw new Error("Chat does not exist.")
  if (chat.active_run_id) {
    const active = workspace.runs.find((run) => run.id === chat.active_run_id)
    if (active && activeStatuses.has(active.status)) {
      const error = new Error("Chat already has an active run.")
      error.statusCode = 409
      throw error
    }
  }
  const status = input.status
  if (!RUN_STATUSES.has(status)) throw new Error("Run status is invalid.")
  const timestamp = now()
  if (!new Set(["pending", "awaiting_supervision"]).has(status)) throw new Error("A run must begin pending or awaiting supervision.")
  const run = { id: assertID(input.run_id, "run_id"), chat_id: chatID, task_id: assertID(input.task_id, "task_id"), content: assertText(input.content, "message content"), route: assertText(input.route, "route", 100), model_selection: input.model_selection ?? "memo", task_plan: Array.isArray(input.task_plan) ? input.task_plan : [], required_route: assertText(input.required_route ?? input.route, "required_route", 100), risk_categories: input.risk_categories ?? [], session_id: input.session_id ?? null, user_message_id: null, assistant_message_id: null, status, approval_nonce: input.approval_nonce ?? null, content_hash: input.content_hash ?? null, approved_at: null, approved_content_hash: null, approval_type: null, created_at: timestamp, updated_at: timestamp, completed_at: null, last_error: null }
  workspace.runs.push(run)
    chat.active_run_id = run.id
    chat.run_status = status
    chat.run_state = status
    chat.last_error = null
    chat.execution = { session_id: chat.session_id, status, updated_at: timestamp }
  chat.updated_at = timestamp
  return run
})

export const getChatRun = async (directory, runID) => {
  assertID(runID, "run_id")
  const run = (await readWorkspace(directory)).runs.find((candidate) => candidate.id === runID)
  if (!run) {
    const error = new Error("Run does not exist.")
    error.statusCode = 404
    throw error
  }
  return run
}

export const updateChatRun = async (directory, input) => mutateWorkspace(directory, async (workspace) => {
  const runID = assertID(input.run_id, "run_id")
  const run = workspace.runs.find((candidate) => candidate.id === runID)
  if (!run) {
    const error = new Error("Run does not exist.")
    error.statusCode = 404
    throw error
  }
  const metadataOnly = input.status === run.status && input.user_message_id !== undefined
  if (!RUN_STATUSES.has(input.status) || (!metadataOnly && !transitions[run.status].has(input.status))) throw new Error(`Run cannot transition from ${run.status} to ${input.status}.`)
  const chat = workspace.chats.find((candidate) => candidate.id === run.chat_id)
  const timestamp = now()
  run.status = input.status
  run.updated_at = timestamp
  run.last_error = input.last_error ?? null
  if (input.session_id !== undefined) run.session_id = assertText(input.session_id, "session_id", 200)
  if (input.user_message_id !== undefined) run.user_message_id = assertID(input.user_message_id, "user_message_id")
  if (!activeStatuses.has(run.status)) run.completed_at = timestamp
  if (!activeStatuses.has(run.status)) workspace.pending_permissions = workspace.pending_permissions.filter((permission) => permission.run_id !== run.id || permission.resolved_at)
  if (chat) {
    chat.run_status = run.status
    chat.run_state = run.status
    chat.last_error = run.last_error
    chat.execution = { session_id: chat.session_id, status: run.status, updated_at: timestamp }
    if (!activeStatuses.has(run.status) && chat.active_run_id === run.id) chat.active_run_id = null
    chat.updated_at = timestamp
  }
  return run
})

export const completeChatRun = async (directory, input) => mutateWorkspace(directory, async (workspace) => {
  const run = workspace.runs.find((candidate) => candidate.id === assertID(input.run_id, "run_id"))
  if (!run) throw Object.assign(new Error("Run does not exist."), { statusCode: 404 })
  if (run.status !== "running") throw new Error(`Run cannot transition from ${run.status} to completed.`)
  const chat = workspace.chats.find((candidate) => candidate.id === run.chat_id)
  if (!chat) throw new Error("Run chat does not exist.")
  const upstreamMessageID = assertText(input.upstream_message_id, "upstream_message_id", 200)
  let message = chat.messages.find((candidate) => candidate.upstream_message_id === upstreamMessageID)
  if (message && message.role !== "assistant") throw new Error("Workspace upstream message ownership is invalid.")
  const timestamp = now()
  if (!message) {
    message = { id: `message-${randomUUID()}`, role: "assistant", content: assertText(input.content, "message content"), upstream_message_id: upstreamMessageID, created_at: timestamp }
    chat.messages.push(message)
  }
  run.status = "completed"; run.assistant_message_id = message.id; run.updated_at = timestamp; run.completed_at = timestamp; run.last_error = null
  workspace.pending_permissions = workspace.pending_permissions.filter((permission) => permission.run_id !== run.id || permission.resolved_at)
  chat.active_run_id = null; chat.run_status = "completed"; chat.run_state = "completed"; chat.last_error = null; chat.execution = { session_id: chat.session_id, status: "completed", updated_at: timestamp }; chat.updated_at = timestamp
  return { run, message }
})

export const reconcileChatRun = async (directory, input) => mutateWorkspace(directory, async (workspace) => {
  const run = workspace.runs.find((candidate) => candidate.id === assertID(input.run_id, "run_id"))
  if (!run) throw Object.assign(new Error("Run does not exist."), { statusCode: 404 })
  const status = input.status
  if (!new Set(["completed", "failed", "cancelled"]).has(status)) throw new Error("Reconciled run status is invalid.")
  const chat = workspace.chats.find((candidate) => candidate.id === run.chat_id)
  if (!chat) throw new Error("Run chat does not exist.")
  const timestamp = now(), lastError = status === "failed" ? assertText(input.last_error, "last_error", 500) : null
  if (status === "completed") {
    const userIndex = chat.messages.findIndex((message) => message.id === run.user_message_id)
    const nextUserIndex = chat.messages.findIndex((message, index) => index > userIndex && message.role === "user")
    const response = userIndex >= 0 && chat.messages.slice(userIndex + 1, nextUserIndex < 0 ? undefined : nextUserIndex).find((message) => message.role === "assistant")
    if (!response) throw new Error("A completed run requires a persisted assistant response.")
    run.assistant_message_id = response.id
  }
  run.status = status; run.updated_at = timestamp; run.completed_at = timestamp; run.last_error = lastError
  workspace.pending_permissions = workspace.pending_permissions.filter((permission) => permission.run_id !== run.id || permission.resolved_at)
  const latest = workspace.runs.filter((candidate) => candidate.chat_id === chat.id).at(-1)
  if (latest === run) { chat.active_run_id = null; chat.run_status = status; chat.run_state = status; chat.last_error = lastError; chat.execution = { session_id: chat.session_id, status, updated_at: timestamp }; chat.updated_at = timestamp }
  return run
})

export const approveChatRun = async (directory, input) => mutateWorkspace(directory, async (workspace) => {
  const run = workspace.runs.find((candidate) => candidate.id === assertID(input.run_id, "run_id"))
  if (!run || run.status !== "awaiting_supervision") throw Object.assign(new Error("Run is not awaiting supervision."), { statusCode: 409 })
  const timestamp = now()
  run.approved_at = timestamp
  run.approved_content_hash = assertText(input.content_hash, "content_hash", 100)
  run.approval_type = "user"
  run.status = "pending"
  run.updated_at = timestamp
  const chat = workspace.chats.find((candidate) => candidate.id === run.chat_id)
  chat.run_status = "pending"; chat.run_state = "pending"; chat.updated_at = timestamp
  return run
})

export const upsertPendingPermission = async (directory, input) => mutateWorkspace(directory, async (workspace) => {
  const run = workspace.runs.find((item) => item.id === assertID(input.run_id, "run_id"))
  if (!run) throw new Error("Run does not exist.")
  const permissionID = assertText(input.permission_id, "permission_id", 200)
  if (run.session_id !== input.session_id) throw new Error("Permission session does not own this run.")
  const record = { run_id: run.id, session_id: assertText(input.session_id, "session_id", 200), permission_id: permissionID, title: assertText(input.title ?? "Permission requested", "permission title", 500), operation_type: assertText(input.operation_type ?? "operation", "permission operation_type", 64), target: input.target ? assertText(input.target, "permission target", 500) : null, created_at: now(), resolved_at: null, response: null }
  const index = workspace.pending_permissions.findIndex((item) => item.run_id === run.id && item.permission_id === permissionID)
  if (index >= 0 && workspace.pending_permissions[index].resolved_at) return workspace.pending_permissions[index]
  if (index >= 0) workspace.pending_permissions[index] = { ...workspace.pending_permissions[index], ...record }
  else workspace.pending_permissions.push(record)
  if (run.status === "running") {
    run.status = "awaiting_permission"; run.updated_at = record.created_at
    const chat = workspace.chats.find((item) => item.id === run.chat_id)
    chat.run_status = run.status; chat.run_state = run.status; chat.updated_at = record.created_at
  }
  return record
})

export const resolvePendingPermission = async (directory, input) => mutateWorkspace(directory, async (workspace) => {
  const permission = workspace.pending_permissions.find((item) => item.run_id === assertID(input.run_id, "run_id") && item.permission_id === assertText(input.permission_id, "permission_id", 200) && !item.resolved_at)
  if (!permission) throw Object.assign(new Error("Pending permission does not exist."), { statusCode: 404 })
  permission.response = assertText(input.response, "permission response", 20)
  permission.resolved_at = now()
  return permission
})
