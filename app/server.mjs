import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, closeSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { MAX_HTTP_BODY_BYTES, MAX_REQUEST_CHARS, createChat, createProject, getWorkspace } from "./workspace.mjs"
import { assessRisk } from "../.opencode/lib/memo-risk.mjs"
import { MemoBridge } from "./bridge.mjs"
import { OpenCodeAdapter } from "./opencode-adapter.mjs"
import { MemoEvents } from "./events.mjs"
import { modelChoices, planTask } from "./orchestration.mjs"
import { createMemory, deleteMemory, invalidateMemory, listMemory, retrieveMemory, setMemoryCollectionEnabled, setMemoryEnabled, setMemoryPinned, updateMemory } from "./memory.mjs"

const appDirectory = dirname(fileURLToPath(import.meta.url))
const publicDirectory = join(appDirectory, "public")
const files = { "/": ["index.html", "text/html; charset=utf-8"], "/app.js": ["app.js", "application/javascript; charset=utf-8"], "/styles.css": ["styles.css", "text/css; charset=utf-8"] }
const activeServers = new Set()
const requestSlots = { active: 0, limit: 64 }
const processStartedAt = Date.now() - Math.round(process.uptime() * 1000)
const publicWorkspace = (workspace) => ({
  schema_version: workspace.schema_version,
  projects: workspace.projects.map(({ id, name, created_at }) => ({ id, name, created_at })),
  chats: workspace.chats.map(({ id, project_id, title, session_id, active_run_id, last_error, run_status, created_at, updated_at, messages }) => ({ id, project_id, title, has_session: Boolean(session_id), active_run_id, last_error, run_status, created_at, updated_at, messages: messages.map(({ id, role, content, created_at }) => ({ id, role, content, created_at })) })),
  runs: workspace.runs.map(({ id, chat_id, task_id, route, model_selection, task_plan, status, created_at, updated_at, completed_at, last_error }) => ({ id, chat_id, task_id, route, model_selection, task_plan, status, created_at, updated_at, completed_at, last_error })),
  pending_permissions: workspace.pending_permissions.filter((item) => !item.resolved_at).map(({ run_id, permission_id, title, operation_type, target, created_at }) => ({ run_id, permission_id, title, operation_type, target, created_at })),
})
const publicRun = (run) => { const { id, chat_id, task_id, route, model_selection, task_plan, status, created_at, updated_at, completed_at, last_error } = run; return { id, chat_id, task_id, route, model_selection, task_plan, status, created_at, updated_at, completed_at, last_error } }
const serverLock = (directory) => {
  const path = join(resolve(directory), ".memo", "server.lock")
  mkdirSync(dirname(path), { recursive: true })
  let descriptor = null, token = null
  try {
    if (existsSync(path)) {
      let owner, alive = false
      try { owner = JSON.parse(readFileSync(path, "utf8")); alive = Number.isInteger(owner.pid) && owner.pid > 0; if (alive) try { process.kill(owner.pid, 0) } catch (error) { alive = error.code === "EPERM" }; if (alive && owner.pid === process.pid && Number.isFinite(owner.process_started_at) && owner.process_started_at !== processStartedAt) alive = false } catch {}
      if (!alive && Date.now() - statSync(path).mtimeMs > 1000) unlinkSync(path)
    }
    descriptor = openSync(path, "wx")
    token = `${process.pid}-${Date.now()}-${Math.random()}`
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, process_started_at: processStartedAt, created_at: Date.now() }))
    return () => { try { closeSync(descriptor) } catch {} try { if (JSON.parse(readFileSync(path, "utf8")).token === token) unlinkSync(path) } catch {} }
  } catch (error) {
    if (descriptor !== null) { try { closeSync(descriptor) } catch {} try { unlinkSync(path) } catch {} }
    if (error.code === "EEXIST") throw Object.assign(new Error("Memo is already serving this workspace."), { code: "MEMO_SERVER_LOCKED" })
    throw error
  }
}

const send = (response, status, payload) => {
  if (status === 204) { response.writeHead(status, { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" }); response.end(); return }
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" })
  response.end(JSON.stringify(payload))
}

const readBody = async (request) => new Promise((resolveBody, reject) => {
  const chunks = []; let bytes = 0, tooLarge = false
  request.on("data", (chunk) => {
    if (tooLarge) return
    bytes += chunk.length
    if (bytes > MAX_HTTP_BODY_BYTES) { tooLarge = true; return }
    chunks.push(chunk)
  })
  request.on("end", () => {
    if (tooLarge) return reject(Object.assign(new Error(`Request body exceeds the ${MAX_HTTP_BODY_BYTES}-byte limit.`), { statusCode: 413, code: "REQUEST_TOO_LARGE" }))
    const body = Buffer.concat(chunks).toString("utf8")
    try { resolveBody(body ? JSON.parse(body) : {}) } catch { reject(Object.assign(new Error("Request body must be JSON."), { statusCode: 400, code: "INVALID_JSON" })) }
  })
  request.on("error", reject)
})

const requireJSON = (request) => {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    const error = new Error("Content-Type must be application/json.")
    error.statusCode = 400
    throw error
  }
}
const localRequest = (request) => {
  const host = request.headers.host?.toLowerCase()
  if (!host || !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) throw Object.assign(new Error("Local requests only."), { statusCode: 403 })
  const origin = request.headers.origin
  if (origin && origin !== `http://${host}`) throw Object.assign(new Error("Invalid Origin."), { statusCode: 403 })
}
const safeError = (error) => {
  const exposed = error.statusCode && error.statusCode < 500 ? error.message : error.code === "OPENCODE_UNAVAILABLE" ? "OpenCode is unavailable. Start a local OpenCode server and set MEMO_OPENCODE_URL." : "Request failed."
  return { error: exposed, code: error.code ?? null }
}

export const createMemoServer = (directory, options = {}) => {
  const instanceKey = resolve(directory)
  if (activeServers.has(instanceKey)) throw new Error("Memo is already serving this workspace in this process.")
  let releaseServerLock, server
  try {
    releaseServerLock = serverLock(directory)
    const events = options.events ?? new MemoEvents()
    let adapter = options.adapter ?? null
    const getAdapter = () => { if (!adapter) adapter = options.adapterFactory ? options.adapterFactory() : new OpenCodeAdapter(); return adapter }
    const publish = (chatID, event) => { if (!events.publish(chatID, event)) throw Object.assign(new Error("Memo could not publish a lifecycle event."), { code: "SSE_PUBLISH_FAILED" }) }
    const reserveEvents = (chatID) => { if (events.reserve && !events.reserve(chatID)) throw Object.assign(new Error("Memo event capacity is full."), { statusCode: 429, code: "SSE_CAPACITY_FULL" }) }
    const bridge = options.bridge ?? new MemoBridge({
      ensureAvailable: () => getAdapter().ensureAvailable(), createSession: (input) => getAdapter().createSession(input), prompt: (input) => getAdapter().prompt(input), abort: (input) => getAdapter().abort(input), listMessages: (input) => getAdapter().listMessages(input), replyPermission: (input) => getAdapter().replyPermission(input),
    })
    server = createServer(async (request, response) => {
    try {
      localRequest(request)
      if (request.method === "GET" && request.url === "/favicon.ico") { response.writeHead(204, { "cache-control": "public, max-age=86400" }); response.end(); return }
      if (request.method === "GET" && files[request.url]) {
        const [file, contentType] = files[request.url]
        response.writeHead(200, { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cross-origin-resource-policy": "same-origin", "cross-origin-opener-policy": "same-origin", "x-frame-options": "DENY", "content-security-policy": "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'" })
        response.end(await readFile(join(publicDirectory, file)))
        return
      }
      if (request.method === "GET" && request.url === "/api/workspace") return send(response, 200, publicWorkspace(await getWorkspace(directory)))
      if (request.method === "GET" && request.url === "/api/models") return send(response, 200, { choices: modelChoices })
      const memoryMatch = request.url?.match(/^\/api\/projects\/([^/]+)\/memory(?:\/([^/]+)(?:\/(invalidate|pin|enable))?)?$/)
      const retrievalMatch = request.url?.match(/^\/api\/projects\/([^/]+)\/memory\/retrieve\?(.+)$/)
      if (retrievalMatch && request.method === "GET") { const query = new URLSearchParams(retrievalMatch[2]); return send(response, 200, await retrieveMemory(directory, retrievalMatch[1], { query: query.get("query"), max_records: query.has("max_records") ? Number(query.get("max_records")) : undefined, char_budget: query.has("char_budget") ? Number(query.get("char_budget")) : undefined })) }
      if (memoryMatch && request.method === "GET" && !memoryMatch[2]) return send(response, 200, await listMemory(directory, memoryMatch[1]))
      if (request.method === "GET" && request.url === "/api/opencode/status") { const { configured, reachable, version } = await getAdapter().status(); return send(response, 200, { configured: Boolean(configured), reachable: Boolean(reachable), version: typeof version === "string" ? version : null }) }
      const eventMatch = request.url?.match(/^\/api\/chats\/([^/]+)\/events$/)
      if (request.method === "GET" && eventMatch) {
        const chatID = eventMatch[1]
        if (!(await getWorkspace(directory)).chats.some((chat) => chat.id === chatID)) return send(response, 404, { error: "Chat does not exist." })
        events.subscribe(chatID, request, response, request.headers["last-event-id"])
        return
      }
      const getRunMatch = request.url?.match(/^\/api\/runs\/([^/]+)$/)
      if (request.method === "GET" && getRunMatch) return send(response, 200, publicRun(await bridge.get(directory, getRunMatch[1])) )
      const approvalMatch = request.url?.match(/^\/api\/runs\/([^/]+)\/approval$/)
      if (request.method === "GET" && approvalMatch) {
        const run = await bridge.get(directory, approvalMatch[1])
        if (run.status !== "awaiting_supervision") return send(response, 404, { error: "Run is not awaiting approval." })
        return send(response, 200, { run_id: run.id, content: run.content, content_hash: run.content_hash, approval_nonce: run.approval_nonce, status: run.status, risk_categories: run.risk_categories, required_route: run.required_route })
      }
      if (request.method !== "POST" && !(memoryMatch && !memoryMatch[3] && ["PUT", "DELETE"].includes(request.method))) return send(response, 404, { error: "Route not found." })
      requireJSON(request)
      if (requestSlots.active >= requestSlots.limit) return send(response, 429, { error: "Server is busy." })
      requestSlots.active += 1
      let body
      try { body = await readBody(request) } finally { requestSlots.active -= 1 }
      if (request.url === "/api/risk") {
        if (typeof body.content !== "string" || !body.content.trim() || body.content.trim().length > MAX_REQUEST_CHARS) throw Object.assign(new Error(`Message content must be non-empty and no longer than ${MAX_REQUEST_CHARS} characters.`), { statusCode: 400 })
        const risk = assessRisk(body.content.trim())
        return send(response, 200, { route: risk.risk === "high" ? risk.required_route : "frontier-orchestrator", risk_categories: risk.matches, requires_approval: risk.risk === "high" })
      }
      if (request.url === "/api/plan") { if (typeof body.content !== "string" || !body.content.trim() || body.content.trim().length > MAX_REQUEST_CHARS) throw Object.assign(new Error("Message content is invalid."), { statusCode: 400 }); const plan = planTask(body.content.trim(), body.model); return send(response, 200, { selected: plan.selected, route: plan.route, risk_categories: plan.risk.matches, requires_approval: plan.risk.risk === "high", steps: plan.steps }) }
       if (request.url === "/api/projects") { const project = await createProject(directory, body); return send(response, 201, { id: project.id, name: project.name, created_at: project.created_at }) }
       if (memoryMatch) {
         const [, projectID, recordID, action] = memoryMatch
         if (!recordID) return send(response, 201, await createMemory(directory, { ...body, project_id: projectID }))
         if (recordID === "collection" && !action && request.method === "PUT") return send(response, 200, await setMemoryCollectionEnabled(directory, projectID, body.enabled))
         if (!action && request.method === "PUT") return send(response, 200, await updateMemory(directory, projectID, recordID, body))
         if (!action && request.method === "DELETE") { await deleteMemory(directory, projectID, recordID); return send(response, 204, {}) }
         if (action === "invalidate") return send(response, 200, await invalidateMemory(directory, projectID, recordID, body))
         if (action === "pin") return send(response, 200, await setMemoryPinned(directory, projectID, recordID, body.pinned))
         if (action === "enable") return send(response, 200, await setMemoryEnabled(directory, projectID, recordID, body.enabled))
       }
      if (request.url === "/api/chats") { const chat = await createChat(directory, body); return send(response, 201, { id: chat.id, project_id: chat.project_id, title: chat.title, created_at: chat.created_at, updated_at: chat.updated_at, messages: [] }) }
      const startMatch = request.url?.match(/^\/api\/chats\/([^/]+)\/runs$/)
      if (startMatch) {
        reserveEvents(startMatch[1])
        const run = await bridge.start(directory, { ...body, chat_id: startMatch[1] }, (event) => publish(startMatch[1], event))
        return send(response, 202, publicRun(run))
      }
      const approveMatch = request.url?.match(/^\/api\/runs\/([^/]+)\/approve$/)
      if (approveMatch) {
        const run = await bridge.get(directory, approveMatch[1])
        reserveEvents(run.chat_id)
        return send(response, 202, publicRun(await bridge.approve(directory, approveMatch[1], body, (event) => publish(run.chat_id, event))))
      }
      const cancelApprovalMatch = request.url?.match(/^\/api\/runs\/([^/]+)\/approval\/cancel$/)
      if (cancelApprovalMatch) {
        const run = await bridge.get(directory, cancelApprovalMatch[1])
        reserveEvents(run.chat_id)
        return send(response, 202, publicRun(await bridge.stop(directory, run.id, (event) => publish(run.chat_id, event))))
      }
      const stopMatch = request.url?.match(/^\/api\/runs\/([^/]+)\/stop$/)
      if (stopMatch) {
        const run = await bridge.get(directory, stopMatch[1])
        reserveEvents(run.chat_id)
        return send(response, 202, publicRun(await bridge.stop(directory, stopMatch[1], (event) => publish(run.chat_id, event))))
      }
      const retryMatch = request.url?.match(/^\/api\/runs\/([^/]+)\/retry$/)
      if (retryMatch) {
        const previous = await bridge.get(directory, retryMatch[1])
        reserveEvents(previous.chat_id)
        return send(response, 202, publicRun(await bridge.retry(directory, retryMatch[1], (event) => publish(previous.chat_id, event))))
      }
      const resumeMatch = request.url?.match(/^\/api\/chats\/([^/]+)\/resume$/)
      if (resumeMatch) return send(response, 200, await bridge.resume(directory, resumeMatch[1]))
      const permissionMatch = request.url?.match(/^\/api\/runs\/([^/]+)\/permissions$/)
      if (permissionMatch) {
        const run = await bridge.get(directory, permissionMatch[1])
        reserveEvents(run.chat_id)
        return send(response, 202, publicRun(await bridge.replyPermission(directory, permissionMatch[1], body, (event) => publish(run.chat_id, event))))
      }
      return send(response, 404, { error: "Route not found." })
    } catch (error) {
      return send(response, error.statusCode ?? 400, safeError(error))
    }
    })
    activeServers.add(instanceKey)
    let released = false
    const release = () => { if (released) return; released = true; activeServers.delete(instanceKey); releaseServerLock() }
    server.once("close", release)
    server.once("error", () => { if (!server.listening) release() })
    server.once("listening", () => bridge.reconcile?.(directory, (event) => { const run = event.run_id && bridge.get(directory, event.run_id); if (run) run.then((item) => publish(item.chat_id, event)).catch((error) => console.error("Memo reconcile publish failed:", error.message)) }).catch((error) => console.error("Memo reconcile failed:", error.message)))
    return server
  } catch (error) {
    activeServers.delete(instanceKey)
    releaseServerLock?.()
    throw error
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const port = Number(process.env.MEMO_PORT ?? 4173)
  const server = createMemoServer(process.cwd())
  server.listen(port, "127.0.0.1", () => console.log(`Memo is available at http://127.0.0.1:${port}`))
}
