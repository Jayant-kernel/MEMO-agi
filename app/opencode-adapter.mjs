const textFrom = (parts) => Array.isArray(parts) ? parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").trim() : ""
const unavailable = () => Object.assign(new Error("OpenCode is unavailable. Start a local OpenCode server and set MEMO_OPENCODE_URL."), { statusCode: 503, code: "OPENCODE_UNAVAILABLE" })
const safeText = (value, limit) => typeof value === "string" && Boolean(value.trim()) && value.length <= limit
const safeField = (value, limit) => safeText(value, limit) && !/[\u0000-\u001f\u007f]/.test(value)
const operation = (value) => safeText(value, 64) && /^[a-z0-9_.:-]+$/i.test(value) ? value : "operation"
const target = (value) => {
  const text = Array.isArray(value) ? value.filter((item) => typeof item === "string").join(", ") : value
  if (!safeText(text, 500) || /[\u0000-\u001f\u007f]/.test(text)) return null
  return text.trim()
}

// This is the only upstream event translation boundary. Unknown shapes are ignored.
export const safeEvent = (raw, sessionID) => {
  const event = raw?.payload ?? raw
  const properties = event?.properties
  const part = properties?.part
  const eventSessionID = properties?.sessionID ?? properties?.sessionId ?? properties?.info?.sessionID ?? part?.sessionID ?? part?.sessionId
  if (!event || typeof event !== "object" || eventSessionID !== sessionID) return null
  if (event.type === "message.updated" && safeField(properties?.info?.id, 200) && new Set(["user", "assistant"]).has(properties.info.role) && (properties.info.parentID === undefined || safeField(properties.info.parentID, 200))) return { type: "message.activity", session_id: sessionID, message_id: properties.info.id, role: properties.info.role, parent_id: properties.info.parentID ?? null }
  if (event.type === "message.part.updated" && part?.type === "text" && typeof properties.delta === "string" && properties.delta.length > 0 && properties.delta.length <= 8000 && safeField(part.messageID, 200)) return { type: "assistant.delta", session_id: sessionID, message_id: part.messageID, content: properties.delta }
  if (event.type === "message.part.updated" && part?.type === "tool" && safeField(part.messageID, 200) && safeField(part.callID, 200)) {
    const status = part.state?.status
    if (!new Set(["running", "completed", "error"]).has(status)) return null
    return { type: status === "running" ? "tool.started" : "tool.completed", session_id: sessionID, message_id: part.messageID, call_id: part.callID, operation_type: operation(part.tool), target: target(part.state?.title ?? part.state?.input?.path ?? part.state?.input?.file ?? part.state?.input?.command), ...(status === "error" ? { outcome: "error" } : {}) }
  }
  if (event.type === "permission.updated" && safeField(properties?.id, 200) && safeField(properties?.title, 500) && safeField(properties?.messageID, 200)) return { type: "permission.requested", session_id: sessionID, message_id: properties.messageID, permission_id: properties.id, title: properties.title.trim(), operation_type: operation(properties.type), target: target(properties.pattern) }
  if (event.type === "permission.replied" && safeField(properties?.permissionID, 200) && new Set(["once", "reject"]).has(properties?.response)) return { type: "permission.resolved", session_id: sessionID, permission_id: properties.permissionID, response: properties.response }
  if (event.type === "session.idle" || event.type === "session.error") return { type: event.type, session_id: sessionID }
  return null
}

export class OpenCodeAdapter {
  constructor(baseURL = process.env.MEMO_OPENCODE_URL, credentials = { username: process.env.MEMO_OPENCODE_USERNAME, password: process.env.MEMO_OPENCODE_PASSWORD }) {
    this.activePrompts = new Map()
    if (!baseURL) { this.baseURL = null; return }
    const url = new URL(baseURL)
    if (!new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname) || url.protocol !== "http:") throw new Error("Memo only connects to a local HTTP OpenCode server.")
    if (Boolean(credentials.username) !== Boolean(credentials.password)) throw new Error("Memo OpenCode username and password must be configured together.")
    this.baseURL = url.origin
    this.headers = credentials.username ? { authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, "utf8").toString("base64")}` } : undefined
  }
  ensureAvailable() { if (!this.baseURL) throw unavailable() }
  async status() {
    if (!this.baseURL) return { configured: false, reachable: false, version: null }
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 1000)
    try { const response = await fetch(this.baseURL, { headers: this.headers, signal: controller.signal }); return { configured: true, reachable: response.ok, version: response.headers.get("x-opencode-version") } } catch { return { configured: true, reachable: false, version: null } } finally { clearTimeout(timeout) }
  }
  async client(projectRoot) {
    this.ensureAvailable()
    const { createOpencodeClient } = await import("@opencode-ai/sdk/client")
    return createOpencodeClient({ baseUrl: this.baseURL, directory: projectRoot, headers: this.headers, throwOnError: true })
  }
  async createSession(input) { return (await (await this.client(input.project_root)).session.create({ body: { title: input.title } })).data.id }
  async abort(input) {
    this.activePrompts.get(input.session_id)?.abort()
    await (await this.client(input.project_root)).session.abort({ path: { id: input.session_id } })
  }
  async listMessages(input) {
    const response = await (await this.client(input.project_root)).session.messages({ path: { id: input.session_id } })
    if (!Array.isArray(response.data)) throw new Error("OpenCode returned invalid session messages.")
    return response.data.map((message) => ({ role: message?.info?.role, content: textFrom(message?.parts), upstream_message_id: message?.info?.id, parent_id: message?.info?.parentID ?? null })).filter((message) => message.content)
  }
  async replyPermission(input) {
    const client = await this.client(input.project_root)
    await client.postSessionIdPermissionsPermissionId({ path: { id: input.session_id, permissionID: input.permission_id }, body: { response: input.response } })
  }
  async prompt(input) {
    const client = await this.client(input.project_root)
    const abortController = new AbortController()
    if (this.activePrompts.has(input.session_id)) throw new Error("OpenCode session already has an active prompt.")
    this.activePrompts.set(input.session_id, abortController)
    let subscription, iterator, completion, accepted = false, correlated = false, assistantID = null
    try {
      subscription = await client.event.subscribe({ query: { directory: input.project_root }, signal: abortController.signal })
      iterator = subscription.stream[Symbol.asyncIterator]()
      const aborted = new Promise((_, reject) => abortController.signal.addEventListener("abort", () => reject(new Error("OpenCode event consumption aborted.")), { once: true }))
      completion = (async () => {
        while (true) {
          const next = iterator.next()
          const item = await Promise.race([next, aborted])
          if (item.done) break
          const raw = item.value
          const event = safeEvent(raw, input.session_id)
          if (!event) continue
          if (event.type === "message.activity" && event.role === "assistant" && event.parent_id === input.user_message_id) { assistantID = event.message_id; correlated = true; continue }
          const messageBound = new Set(["assistant.delta", "tool.started", "tool.completed", "permission.requested"]).has(event.type)
          if (messageBound && event.message_id !== assistantID) continue
          if (event.type === "session.error") throw new Error("OpenCode reported a session error.")
          if (event.type !== "session.idle") await input.onEvent?.(event)
          if (event.type === "session.idle" && accepted && correlated) { await input.onEvent?.(event); return }
        }
        throw new Error("OpenCode event stream ended before the current prompt completed.")
      })()
      // promptAsync can still be pending when stream consumption fails or is aborted.
      // Observe that rejection now; the awaited completion below remains authoritative.
      completion.catch(() => {})
      await client.session.promptAsync({ path: { id: input.session_id }, body: { messageID: input.user_message_id, agent: input.route, parts: [{ type: "text", text: input.content }] } })
      accepted = true
      await completion
      const messages = await this.listMessages(input)
      const assistant = [...messages].reverse().find((message) => message.role === "assistant" && message.parent_id === input.user_message_id)
      if (!assistant?.content || !assistant.upstream_message_id) throw new Error("OpenCode returned no correlated assistant text response.")
      return { text: assistant.content, user_upstream_message_id: input.user_message_id, upstream_message_id: assistant.upstream_message_id }
    } finally {
      abortController.abort()
      if (this.activePrompts.get(input.session_id) === abortController) this.activePrompts.delete(input.session_id)
      try { iterator?.return?.()?.catch?.(() => {}) } catch {}
      if (completion) await completion.catch(() => {})
    }
  }
}
