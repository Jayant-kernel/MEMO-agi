const RUN_STATUSES = new Set(["pending", "awaiting_supervision", "running", "awaiting_permission", "completed", "failed", "cancelled"])
const ID = /^[a-z0-9][a-z0-9_-]{2,79}$/i

const validID = (value) => typeof value === "string" && ID.test(value)
const validText = (value, length = 8000) => typeof value === "string" && value.trim() && value.length <= length
const safeOperation = (value) => validText(value, 64) && /^[a-z0-9_.:-]+$/i.test(value)
const safeTarget = (value) => validText(value, 500) && !/[\u0000-\u001f\u007f]/.test(value)

// Memo never forwards adapter events. This is the complete, stable SSE contract.
const validate = (chatID, event) => {
  if (!validID(chatID) || !event || typeof event !== "object" || !validID(event.run_id)) return null
  if (event.type === "status" && RUN_STATUSES.has(event.status)) {
    return { type: "status", chat_id: chatID, run_id: event.run_id, status: event.status, ...(validID(event.message_id) ? { message_id: event.message_id } : {}) }
  }
  if (event.type === "assistant" && event.message?.role === "assistant" && validID(event.message.id) && validText(event.message.content) && typeof event.message.created_at === "string") {
    return { type: "assistant", chat_id: chatID, run_id: event.run_id, message: { id: event.message.id, role: "assistant", content: event.message.content, created_at: event.message.created_at } }
  }
  if (event.type === "assistant.delta" && typeof event.content === "string" && event.content.length > 0 && event.content.length <= 8000) return { type: "assistant.delta", chat_id: chatID, run_id: event.run_id, content: event.content }
  if (new Set(["tool.started", "tool.completed"]).has(event.type) && safeOperation(event.operation_type) && (event.target === null || event.target === undefined || safeTarget(event.target))) return { type: event.type, chat_id: chatID, run_id: event.run_id, operation_type: event.operation_type, target: event.target ?? null }
  if (event.type === "permission.requested" && validText(event.permission_id, 200) && validText(event.title, 500) && safeOperation(event.operation_type) && (event.target === null || event.target === undefined || safeTarget(event.target))) return { type: event.type, chat_id: chatID, run_id: event.run_id, permission_id: event.permission_id, title: event.title, operation_type: event.operation_type, target: event.target ?? null }
  if (event.type === "permission.resolved" && validText(event.permission_id, 200) && new Set(["once", "reject"]).has(event.response)) return { type: event.type, chat_id: chatID, run_id: event.run_id, permission_id: event.permission_id, response: event.response }
  if (new Set(["session.idle", "session.error"]).has(event.type)) return { type: event.type, chat_id: chatID, run_id: event.run_id }
  return null
}

const frame = (id, event) => `id: ${id}\nevent: memo\ndata: ${JSON.stringify(event)}\n\n`

export class MemoEvents {
  constructor({ limit = 100, runLimit = 25, chatLimit = 100, listenerLimit = 100, ttlMs = 300000, heartbeatMs = 15000 } = {}) {
    this.limit = limit
    this.runLimit = runLimit
    this.chatLimit = chatLimit; this.listenerLimit = listenerLimit; this.ttlMs = ttlMs; this.heartbeatMs = heartbeatMs
    this.chats = new Map()
  }

  state(chatID) {
    let state = this.chats.get(chatID)
    if (state) return state
    this.evict()
    if (!state) {
      if (this.chats.size >= this.chatLimit) {
        const candidate = [...this.chats.entries()].find(([, item]) => !item.listeners.size)
        if (candidate) this.chats.delete(candidate[0])
      }
      if (this.chats.size >= this.chatLimit) return null
      state = { nextID: 1, runs: new Map(), listeners: new Set(), touched: Date.now() }
      this.chats.set(chatID, state)
    }
    return state
  }

  evict() {
    const cutoff = Date.now() - this.ttlMs
    for (const [chatID, state] of this.chats) if (!state.listeners.size && state.touched < cutoff) this.chats.delete(chatID)
    while (this.chats.size >= this.chatLimit) {
      const candidate = [...this.chats.entries()].find(([, state]) => !state.listeners.size)
      if (!candidate) break
      this.chats.delete(candidate[0])
    }
  }

  publish(chatID, event) {
    const safe = validate(chatID, event)
    if (!safe) return false
    const state = this.state(chatID)
    if (!state) return false
    state.touched = Date.now()
    const entry = { id: state.nextID++, event: safe }
    const isNewRun = !state.runs.has(safe.run_id)
    const replay = state.runs.get(safe.run_id) ?? []
    replay.push(entry)
    if (replay.length > this.limit) replay.shift()
    state.runs.set(safe.run_id, replay)
    if (isNewRun && state.runs.size > this.runLimit) state.runs.delete(state.runs.keys().next().value)
    for (const response of state.listeners) if (!response.writableEnded) response.write(frame(entry.id, safe))
    return true
  }

  reserve(chatID) { return Boolean(this.state(chatID)) }

  subscribe(chatID, request, response, lastEventID) {
    const state = this.state(chatID)
    if (!state) { response.writeHead(429, { "cache-control": "no-store" }); response.end(); return false }
    if (state.listeners.size >= this.listenerLimit) { response.writeHead(429, { "cache-control": "no-store" }); response.end(); return false }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no", "x-content-type-options": "nosniff" })
    response.write(": connected\n\n")
    state.listeners.add(response)
    const last = Number.parseInt(lastEventID, 10)
    if (Number.isSafeInteger(last) && last >= 0) {
      for (const entry of [...state.runs.values()].flat().sort((a, b) => a.id - b.id)) if (entry.id > last) response.write(frame(entry.id, entry.event))
    }
    const heartbeat = setInterval(() => { if (!response.writableEnded) response.write(": heartbeat\n\n") }, this.heartbeatMs)
    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      clearInterval(heartbeat)
      state.listeners.delete(response)
      state.touched = Date.now()
      if (!state.listeners.size) setTimeout(() => { const current = this.chats.get(chatID); if (current === state && !current.listeners.size && Date.now() - current.touched >= this.ttlMs) this.chats.delete(chatID) }, this.ttlMs).unref?.()
    }
    request.once("close", cleanup)
    response.once("close", cleanup)
    return true
  }
}
