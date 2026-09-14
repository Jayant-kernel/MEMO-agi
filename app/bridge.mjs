import { createHash, randomUUID } from "node:crypto"
import { createManifest, createRun, finishRun as closeRun, getMemoState, recordRunEvent as writeRunEvent, startRun } from "../.opencode/lib/memo-state.mjs"
import { assessRisk } from "../.opencode/lib/memo-risk.mjs"
import { planTask } from "./orchestration.mjs"
import { MAX_REQUEST_CHARS, addMessage, approveChatRun, completeChatRun, createChatRun, getChatRun, getPendingPermissions, getWorkspace, reconcileChatRun, resolvePendingPermission, setChatExecution, setMessageUpstreamID, updateChatRun, upsertPendingPermission } from "./workspace.mjs"

const activeStatuses = new Set(["pending", "awaiting_supervision", "running", "awaiting_permission"])
const text = (value, label, maxLength = MAX_REQUEST_CHARS) => { if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) throw new Error(`${label} must be non-empty and no longer than ${maxLength} characters.`); return value.trim() }
const conflict = (message) => Object.assign(new Error(message), { statusCode: 409 })
const hash = (value) => createHash("sha256").update(value).digest("hex")
const safeOperation = (value) => typeof value === "string" && value.length <= 64 && /^[a-z0-9_.:-]+$/i.test(value)
const safeTarget = (value) => value === null || value === undefined || (typeof value === "string" && value.trim() && value.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value))

export class MemoBridge {
  constructor(adapter, state = {}) { this.adapter = adapter; this.state = { createManifest, createRun, addMessage, ...state }; this.running = new Map(); this.ledgerQueues = new Map(); this.lifecycleQueues = new Map(); this.stopping = new Set() }

  async start(directory, input, emit = () => {}) {
    const workspace = await getWorkspace(directory)
    const chat = workspace.chats.find((item) => item.id === input.chat_id)
    if (!chat) throw Object.assign(new Error("Chat does not exist."), { statusCode: 404 })
    const project = workspace.projects.find((item) => item.id === chat.project_id)
    const content = text(input.content, "Message content")
    const plan = planTask(content, input.model)
    const risk = plan.risk, route = plan.route
    const taskID = `task-${randomUUID()}`, runID = `run-${randomUUID()}`
    const contentHash = hash(content), nonce = risk.risk === "high" ? randomUUID() : null
    let run = await createChatRun(directory, { chat_id: chat.id, run_id: runID, task_id: taskID, content, route, model_selection: plan.selected, task_plan: plan.steps, required_route: risk.required_route, risk_categories: risk.matches, session_id: chat.session_id, status: risk.risk === "high" ? "awaiting_supervision" : "pending", approval_nonce: nonce, content_hash: contentHash })
    try {
      await this.state.createManifest(project.root, { task_id: taskID, title: chat.title, request: content, risk: risk.risk, route, acceptance_criteria: ["Record the server-authoritative run lifecycle."], verification: ["Inspect the Memo run ledger."] })
      await this.state.createRun(project.root, { run_id: run.id, task_id: run.task_id, task: content, route, models: [], status: "pending" })
      let userMessageID = input.local_user_message_id
      if (input.record_user !== false) userMessageID = (await this.state.addMessage(directory, { chat_id: chat.id, content, role: "user" })).id
      if (userMessageID) run = await updateChatRun(directory, { run_id: run.id, status: run.status, user_message_id: userMessageID })
    } catch (error) {
      await this.finishIfStarted(project.root, run.id, "failed", "Memo could not initialize this run.")
      await updateChatRun(directory, { run_id: runID, status: "failed", last_error: "Memo could not initialize this run." })
      throw error
    }
    emit({ type: "status", status: run.status, run_id: runID })
    if (run.status === "pending") this.execute(directory, runID, emit).catch(() => {})
    return run
  }

  async approve(directory, runID, input = {}, emit = () => {}) {
    const run = await getChatRun(directory, runID)
    if (run.status !== "awaiting_supervision") throw conflict("Run is not awaiting supervision.")
    if (text(input.content, "Approval content") !== run.content || input.content_hash !== run.content_hash || input.approval_nonce !== run.approval_nonce) throw conflict("Approval does not match this exact high-risk request.")
    const approved = await approveChatRun(directory, { run_id: run.id, content_hash: run.content_hash })
    emit({ type: "status", status: approved.status, run_id: run.id })
    this.execute(directory, run.id, emit).catch(() => {})
    return approved
  }

  async stop(directory, runID, emit = () => {}) {
    const run = await getChatRun(directory, runID)
    if (!activeStatuses.has(run.status)) throw conflict("Run is already finished.")
    this.stopping.add(run.id)
    try {
      const project = await this.projectForRun(directory, run)
      if (run.session_id && this.adapter.abort) {
        try { await this.adapter.abort({ project_root: project.root, session_id: run.session_id }) }
        catch (error) {
          const failed = await this.lifecycle(run.id, async () => {
            const current = await getChatRun(directory, run.id)
            if (!activeStatuses.has(current.status)) return current
            await this.finishIfStarted(project.root, run.id, "failed", "OpenCode abort failed.")
            return updateChatRun(directory, { run_id: run.id, status: "failed", last_error: "OpenCode abort failed." })
          })
          emit({ type: "status", status: failed.status, run_id: run.id })
          if (failed.status !== "failed") return failed
          throw Object.assign(new Error("OpenCode abort failed."), { statusCode: 502, cause: error })
        }
      }
      const cancelled = await this.lifecycle(run.id, async () => {
        const current = await getChatRun(directory, run.id)
        if (!activeStatuses.has(current.status)) return current
        await this.finishIfStarted(project.root, run.id, "cancelled", "Stopped by user.")
        return updateChatRun(directory, { run_id: run.id, status: "cancelled" })
      })
      emit({ type: "status", status: cancelled.status, run_id: run.id })
      return cancelled
    } finally {
      this.stopping.delete(run.id)
    }
  }

  get(directory, runID) { return getChatRun(directory, runID) }
  async retry(directory, runID, emit = () => {}) { const run = await getChatRun(directory, runID); if (!new Set(["failed", "cancelled"]).has(run.status)) throw conflict("Only failed or cancelled runs can be retried."); return this.start(directory, { chat_id: run.chat_id, content: run.content, record_user: false, local_user_message_id: run.user_message_id }, emit) }
  async resume(directory, chatID) {
    const workspace = await getWorkspace(directory), chat = workspace.chats.find((item) => item.id === chatID)
    if (!chat) throw Object.assign(new Error("Chat does not exist."), { statusCode: 404 })
    const project = workspace.projects.find((item) => item.id === chat.project_id)
    if (!project || !chat.session_id) throw conflict("Chat has no resumable session.")
    const messages = await this.adapter.listMessages({ project_root: project.root, session_id: chat.session_id })
    if (!Array.isArray(messages)) throw new Error("Adapter returned invalid session messages.")
    // Refresh the persisted transcript from the authoritative session without inventing a run.
    for (const message of messages) if (new Set(["user", "assistant", "system"]).has(message?.role) && typeof message.content === "string" && message.content.trim() && message.upstream_message_id) await addMessage(directory, { chat_id: chat.id, role: message.role, content: message.content, upstream_message_id: message.upstream_message_id })
    return { chat_id: chat.id, message_count: messages.length }
  }

  async replyPermission(directory, runID, input, emit = () => {}) {
    const run = await getChatRun(directory, runID)
    if (run.status !== "awaiting_permission" || !run.session_id) throw conflict("Run is not awaiting a permission response.")
    const permissionID = text(input.permission_id, "Permission permission_id"), response = input.response
    if (!new Set(["once", "reject"]).has(response)) throw new Error("Permission response is invalid.")
    if (!(await getPendingPermissions(directory, run.id)).some((item) => item.permission_id === permissionID && item.session_id === run.session_id)) throw Object.assign(new Error("Pending permission does not exist."), { statusCode: 404 })
    const project = await this.projectForRun(directory, run)
    await this.adapter.replyPermission({ project_root: project.root, session_id: run.session_id, permission_id: permissionID, response })
    await resolvePendingPermission(directory, { run_id: run.id, permission_id: permissionID, response })
    emit({ type: "permission.resolved", run_id: run.id, permission_id: permissionID, response })
    if ((await getPendingPermissions(directory, run.id)).length) return await getChatRun(directory, run.id)
    const resumed = await updateChatRun(directory, { run_id: run.id, status: "running" })
    emit({ type: "status", status: "running", run_id: run.id })
    return resumed
  }

  async run(directory, input, emit = () => {}) {
    if (input.approved !== true) throw new Error("Explicit approval is required before model execution.")
    const run = await this.start(directory, input, emit)
    return run.status === "awaiting_supervision" ? run : this.running.get(run.id)
  }

  async reconcile(directory, emit = () => {}) {
    const workspace = await getWorkspace(directory)
    for (const run of workspace.runs.filter((item) => item.status !== "awaiting_supervision")) {
      const project = await this.projectForRun(directory, run)
      let ledger = null
      try { ledger = await getMemoState(project.root, { run_id: run.id }) } catch (error) { if (error.code !== "ENOENT") throw error }
      const ledgerTerminal = { passed: "completed", failed: "failed", blocked: "failed", cancelled: "cancelled" }[ledger?.status]
      if (ledgerTerminal) {
        const chat = workspace.chats.find((candidate) => candidate.id === run.chat_id)
        const userIndex = chat?.messages.findIndex((message) => message.id === run.user_message_id) ?? -1
        const nextUserIndex = chat?.messages.findIndex((message, index) => index > userIndex && message.role === "user") ?? -1
        const hasResponse = userIndex >= 0 && chat.messages.slice(userIndex + 1, nextUserIndex < 0 ? undefined : nextUserIndex).some((message) => message.role === "assistant")
        if (ledgerTerminal === "completed" && hasResponse && run.status !== "completed") {
          const reconciled = await reconcileChatRun(directory, { run_id: run.id, status: "completed" })
          emit({ type: "status", status: reconciled.status, run_id: reconciled.id })
        } else if (ledgerTerminal === "completed" && !hasResponse && activeStatuses.has(run.status)) {
          const reconciled = await reconcileChatRun(directory, { run_id: run.id, status: "failed", last_error: "The Memo ledger completed without a persisted assistant response. Retry to continue." })
          emit({ type: "status", status: reconciled.status, run_id: reconciled.id })
        } else if (ledgerTerminal !== "completed" && activeStatuses.has(run.status)) {
          const reconciled = await reconcileChatRun(directory, { run_id: run.id, status: ledgerTerminal, last_error: ledgerTerminal === "failed" ? "The Memo ledger recorded a failed run." : undefined })
          emit({ type: "status", status: reconciled.status, run_id: reconciled.id })
        }
        continue
      }
      if (run.status === "completed") { await this.finishIfStarted(project.root, run.id, "passed", "OpenCode response recorded."); continue }
      if (run.status === "failed" || run.status === "cancelled") { await this.finishIfStarted(project.root, run.id, run.status, run.last_error ?? (run.status === "failed" ? "OpenCode execution failed." : "Stopped by user.")); continue }
      if (!activeStatuses.has(run.status)) continue
      const ledgerRunning = ledger?.status === "running"
      await this.finishIfStarted(project.root, run.id, "failed", ledgerRunning ? "Memo restarted before this run completed." : "Memo restarted before initialization completed.")
      const failed = await reconcileChatRun(directory, { run_id: run.id, status: "failed", last_error: ledgerRunning ? "Memo restarted before this run completed. Retry to continue." : "Memo restarted before initialization completed. Retry to continue." })
      emit({ type: "status", status: failed.status, run_id: failed.id })
    }
  }

  async projectForRun(directory, run) { const workspace = await getWorkspace(directory); const chat = workspace.chats.find((item) => item.id === run.chat_id); const project = chat && workspace.projects.find((item) => item.id === chat.project_id); if (!project) throw new Error("Run project does not exist."); return project }
  serial(runID, operation) { const previous = this.ledgerQueues.get(runID) ?? Promise.resolve(); const queued = previous.catch(() => {}).then(operation); this.ledgerQueues.set(runID, queued); queued.finally(() => { if (this.ledgerQueues.get(runID) === queued) this.ledgerQueues.delete(runID) }).catch(() => {}); return queued }
  lifecycle(runID, operation) { const previous = this.lifecycleQueues.get(runID) ?? Promise.resolve(); const queued = previous.catch(() => {}).then(operation); this.lifecycleQueues.set(runID, queued); queued.finally(() => { if (this.lifecycleQueues.get(runID) === queued) this.lifecycleQueues.delete(runID) }).catch(() => {}); return queued }
  record(projectRoot, input) { return this.serial(input.run_id, () => writeRunEvent(projectRoot, input)) }
  finish(projectRoot, input) { return this.serial(input.run_id, () => closeRun(projectRoot, input)) }
  async finishIfStarted(projectRoot, runID, status, outcome) { try { await this.finish(projectRoot, { run_id: runID, status, outcome }) } catch (error) { if (error.code !== "ENOENT" && !/already/.test(error.message)) throw error } }
  async execute(directory, runID, emit) { if (this.running.has(runID)) return this.running.get(runID); const work = this.executeRun(directory, runID, emit).finally(() => { this.running.delete(runID); this.stopping.delete(runID) }); this.running.set(runID, work); return work }

  async executeRun(directory, runID, emit) {
    let run = await getChatRun(directory, runID)
    if (run.status !== "pending") return run
    const project = await this.projectForRun(directory, run)
    let sessionID = run.session_id
    try {
      if (!sessionID) {
        const chat = (await getWorkspace(directory)).chats.find((item) => item.id === run.chat_id)
        if (this.adapter.createSession) sessionID = await this.adapter.createSession({ project_root: project.root, title: chat.title })
        if (!sessionID) throw new Error("Adapter did not return a session_id.")
      }
      await setChatExecution(directory, { chat_id: run.chat_id, session_id: sessionID, status: "pending" })
      await this.serial(run.id, () => startRun(project.root, { run_id: run.id }))
      run = await updateChatRun(directory, { run_id: run.id, status: "running", session_id: sessionID })
       const upstreamUserMessageID = `msg-${randomUUID()}`
      if (run.user_message_id) await setMessageUpstreamID(directory, { chat_id: run.chat_id, message_id: run.user_message_id, upstream_message_id: upstreamUserMessageID })
      if (run.approved_at) await this.record(project.root, { run_id: run.id, type: "approval", summary: "User approved the exact high-risk request before execution.", evidence: [{ approved_at: run.approved_at, approved_content_hash: run.approved_content_hash, approval_type: "user", risk_categories: run.risk_categories, required_route: run.required_route }] })
      await this.record(project.root, { run_id: run.id, type: "route", summary: `Server selected ${run.route}.` })
      emit({ type: "status", status: "running", run_id: run.id })
      const result = await this.adapter.prompt({ project_root: project.root, session_id: sessionID, user_message_id: upstreamUserMessageID, content: run.content, route: run.route, onEvent: async (event) => this.handleAdapterEvent(directory, run.id, event, emit) })
      return await this.lifecycle(run.id, async () => {
        const current = await getChatRun(directory, run.id)
        if (this.stopping.has(run.id) || current.status === "cancelled" || current.status === "failed" || current.status === "awaiting_permission") return current
        if (result.user_upstream_message_id !== undefined && result.user_upstream_message_id !== upstreamUserMessageID) throw new Error("OpenCode response does not match the current prompt.")
        if (typeof result.upstream_message_id !== "string" || !result.upstream_message_id.trim()) throw new Error("OpenCode returned no assistant message ID.")
        const responseText = text(result.text, "Assistant response")
        await this.record(project.root, { run_id: run.id, type: "completion", summary: "OpenCode response recorded." })
        const { run: completed, message: assistant } = await completeChatRun(directory, { run_id: run.id, content: responseText, upstream_message_id: result.upstream_message_id })
        emit({ type: "status", status: "completed", run_id: run.id, message_id: assistant.id }); emit({ type: "assistant", run_id: run.id, message: assistant })
        await this.finish(project.root, { run_id: run.id, status: "passed", outcome: "OpenCode response recorded." })
        return { ...completed, session_id: sessionID, message: assistant }
      })
    } catch (error) {
      const failed = await this.lifecycle(run.id, async () => {
        const current = await getChatRun(directory, run.id)
        if (this.stopping.has(run.id) || current.status === "cancelled" || current.status === "failed" || current.status === "completed") return current
        await this.finishIfStarted(project.root, run.id, "failed", "OpenCode execution failed.")
        return updateChatRun(directory, { run_id: run.id, status: "failed", last_error: "OpenCode execution failed." })
      })
      if (this.stopping.has(run.id) || failed.status === "cancelled" || failed.status === "completed") return failed
      emit({ type: "status", status: "failed", run_id: run.id }); throw error
    }
  }

  async handleAdapterEvent(directory, runID, event, emit = () => {}) {
    if (event.type === "assistant.delta") {
      const run = await getChatRun(directory, runID)
      if (run.status === "running" && event.session_id === run.session_id && typeof event.content === "string" && event.content.length > 0 && event.content.length <= MAX_REQUEST_CHARS) emit({ type: "assistant.delta", run_id: run.id, content: event.content })
      return
    }
    if (event.type === "tool.started" || event.type === "tool.completed") { const run = await getChatRun(directory, runID); if (run.status === "running" && event.session_id === run.session_id && safeOperation(event.operation_type) && safeTarget(event.target)) emit({ type: event.type, run_id: run.id, operation_type: event.operation_type, target: event.target ?? null }); return }
    if (event.type === "session.idle" || event.type === "session.error") { const run = await getChatRun(directory, runID); if (event.session_id === run.session_id) emit({ type: event.type, run_id: run.id }); return }
    if (event.type !== "permission.requested") return
    const run = await getChatRun(directory, runID)
    if (!new Set(["running", "awaiting_permission"]).has(run.status) || event.session_id !== run.session_id || typeof event.permission_id !== "string" || !event.permission_id.trim() || typeof event.title !== "string" || !event.title.trim() || !safeOperation(event.operation_type) || !safeTarget(event.target)) return
    const permission = await upsertPendingPermission(directory, { run_id: run.id, session_id: run.session_id, permission_id: event.permission_id, title: event.title, operation_type: event.operation_type, target: event.target })
    if (permission.resolved_at) return
    emit({ type: "permission.requested", run_id: run.id, permission_id: event.permission_id, title: event.title, operation_type: event.operation_type, target: event.target ?? null })
    if (run.status === "running") {
      emit({ type: "status", status: "awaiting_permission", run_id: run.id })
    }
  }
}
