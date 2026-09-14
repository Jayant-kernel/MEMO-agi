const state = { workspace: null, memory: null, projectID: null, chatID: null, events: null, error: "", pendingContent: "", deltas: new Map(), permissionFocus: null, editingMemoryID: null }
const $ = (selector) => document.querySelector(selector)
const activeStatuses = new Set(["pending", "awaiting_supervision", "running", "awaiting_permission"])
const validID = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9_-]{2,79}$/i.test(value)

const request = async (path, options = {}) => {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options })
  const data = response.status === 204 ? null : await response.json()
  if (!response.ok) throw new Error(data.error || "Request failed.")
  return data
}

const selectedProject = () => state.workspace.projects.find((project) => project.id === state.projectID)
const selectedChat = () => state.workspace.chats.find((chat) => chat.id === state.chatID)
const latestRun = (chat) => state.workspace.runs.filter((run) => run.chat_id === chat?.id).at(-1)
const showError = (error) => { state.error = error?.message || String(error); render() }

const connectEvents = () => {
  state.events?.close()
  state.events = null
  if (!state.chatID) return
  const chatID = state.chatID
  const events = new EventSource(`/api/chats/${encodeURIComponent(chatID)}/events`)
  state.events = events
  events.addEventListener("memo", (message) => {
    let event
    try { event = JSON.parse(message.data) } catch { return }
    if (chatID !== state.chatID || event.chat_id !== chatID || !validID(event.run_id)) return
    if (event.type === "assistant.delta" && typeof event.content === "string") { state.deltas.set(event.run_id, `${state.deltas.get(event.run_id) ?? ""}${event.content}`.slice(-8000)); render(); return }
    if (event.type === "status") { if (["completed", "failed", "cancelled"].includes(event.status)) state.deltas.delete(event.run_id); refresh().catch(showError) }
    if (event.type === "assistant" && event.message?.role === "assistant" && validID(event.message.id) && typeof event.message.content === "string" && event.message.content.length <= 8000) refresh().catch(showError)
  })
}

const selectChat = async (projectID, chatID) => {
  state.projectID = projectID
  state.chatID = chatID
  state.memory = null
  connectEvents()
  const memory = projectID ? await request(`/api/projects/${encodeURIComponent(projectID)}/memory`) : null
  if (state.projectID !== projectID || state.chatID !== chatID) return
  state.memory = memory
  render()
}

const memoryButton = (label, action) => { const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.onclick = action; return button }
const renderMemory = (project) => {
  const panel = document.createElement("section"); panel.className = "memory-panel"; panel.setAttribute("aria-label", "Project memory")
  const title = document.createElement("h2"); title.textContent = "Project memory"; panel.append(title)
  const note = document.createElement("p"); note.textContent = "Local, project-scoped advisory notes. Memory stays disabled until you explicitly create a note; it is never sent to execution prompts."; panel.append(note)
  if (!project) return panel
  const memory = state.memory ?? { enabled: false, records: [] }
  const status = document.createElement("p"); status.className = "memory-status"; status.textContent = memory.enabled ? "Collection enabled" : "Collection disabled. Create a note to enable it."; panel.append(status)
  panel.append(memoryButton(memory.enabled ? "Disable collection" : "Enable collection", async () => { try { await request(`/api/projects/${encodeURIComponent(project.id)}/memory/collection`, { method: "PUT", body: JSON.stringify({ enabled: !memory.enabled }) }); await loadMemory(); render() } catch (error) { showError(error) } }))
  const form = document.createElement("form"); form.className = "memory-create"
  const content = document.createElement("textarea"); content.placeholder = "Add a local project note"; content.maxLength = 4000; content.required = true; content.setAttribute("aria-label", "Memory note")
  const source = document.createElement("input"); source.placeholder = "Source"; source.maxLength = 500; source.required = true; source.setAttribute("aria-label", "Memory source")
  const condition = document.createElement("input"); condition.placeholder = "Invalid when..."; condition.maxLength = 500; condition.required = true; condition.setAttribute("aria-label", "Memory invalidation condition")
  const create = memoryButton("Create note", async () => { try { await request(`/api/projects/${encodeURIComponent(project.id)}/memory`, { method: "POST", body: JSON.stringify({ content: content.value, source: source.value, provenance: "user", owner: "user", confidence: "medium", invalidation_condition: condition.value }) }); await loadMemory(); render() } catch (error) { showError(error) } })
  form.onsubmit = (event) => { event.preventDefault(); create.click() }; form.append(content, source, condition, create); panel.append(form)
  const list = document.createElement("div"); list.className = "memory-list"
  for (const record of memory.records) {
    const item = document.createElement("article"); item.className = "memory-record"
    const body = document.createElement("p"); body.textContent = record.content
    const meta = document.createElement("small"); meta.textContent = `${record.provenance} / ${record.verification} / ${record.confidence}${record.pinned ? " / pinned" : ""}${record.enabled ? "" : " / disabled"} / ${record.source} / ${record.owner} / updated ${new Date(record.updated_at).toLocaleString()}`
    const actions = document.createElement("div"); actions.className = "memory-actions"
    const mutate = async (path, payload, method = "POST") => { try { await request(path, { method, body: JSON.stringify(payload) }); await loadMemory(); render() } catch (error) { showError(error) } }
    actions.append(
      memoryButton("Edit", () => { state.editingMemoryID = record.id; $("#memory-edit-content").value = record.content; $("#memory-edit-source").value = record.source; $("#memory-edit-condition").value = record.invalidation_condition; $("#memory-edit-confidence").value = record.confidence; $("#memory-edit-error").textContent = ""; $("#memory-edit-dialog").showModal() }),
      memoryButton(record.pinned ? "Unpin" : "Pin", () => mutate(`/api/projects/${encodeURIComponent(project.id)}/memory/${encodeURIComponent(record.id)}/pin`, { pinned: !record.pinned })),
      memoryButton(record.enabled ? "Disable" : "Enable", () => mutate(`/api/projects/${encodeURIComponent(project.id)}/memory/${encodeURIComponent(record.id)}/enable`, { enabled: !record.enabled })),
      memoryButton("Invalidate", () => mutate(`/api/projects/${encodeURIComponent(project.id)}/memory/${encodeURIComponent(record.id)}/invalidate`, { invalidation_condition: "Manually invalidated by user." })),
      memoryButton("Delete", () => mutate(`/api/projects/${encodeURIComponent(project.id)}/memory/${encodeURIComponent(record.id)}`, {}, "DELETE")),
    )
    item.append(body, meta, actions); list.append(item)
  }
  panel.append(list); return panel
}

const render = () => {
  const project = selectedProject()
  const chat = selectedChat()
  $("#project-list").replaceChildren(...state.workspace.projects.map((candidate) => {
    const projectButton = document.createElement("button")
    projectButton.className = `project ${candidate.id === state.projectID ? "selected" : ""}`
    projectButton.textContent = candidate.name
    projectButton.onclick = () => selectChat(candidate.id, state.workspace.chats.find((item) => item.project_id === candidate.id)?.id ?? null).catch(showError)
    const chats = state.workspace.chats.filter((item) => item.project_id === candidate.id).map((item) => {
      const chatButton = document.createElement("button")
      chatButton.className = `chat ${item.id === state.chatID ? "selected" : ""}`
      chatButton.textContent = item.title
      chatButton.onclick = () => selectChat(candidate.id, item.id).catch(showError)
      return chatButton
    })
    const group = document.createElement("div")
    group.className = "project-group"
    group.append(projectButton, ...chats)
    return group
  }))
  $("#project-path").textContent = project ? "LOCAL PROJECT" : "LOCAL WORKSPACE"
  $("#chat-title").textContent = chat?.title ?? (project ? "No chat selected" : "Choose a project")
  $("#new-chat").disabled = !project
  const run = latestRun(chat)
  $("#model").disabled = !chat || Boolean(run && activeStatuses.has(run.status))
  $("#message").disabled = !chat
  $("#send").disabled = !chat || Boolean(run && activeStatuses.has(run.status))
  $("#run-status").textContent = state.error || (run ? `Run ${run.status}${run.last_error ? `: ${run.last_error}` : ""}` : "")
  $("#stop").hidden = !run || !activeStatuses.has(run.status)
  $("#retry").hidden = !run || !["failed", "cancelled"].includes(run.status)
  $("#resume").hidden = !chat?.has_session
  $("#review-approval").hidden = run?.status !== "awaiting_supervision"
  const conversation = $("#conversation")
  conversation.replaceChildren()
  if (run?.task_plan?.length) { const plan = document.createElement("section"); plan.className = "task-plan"; const title = document.createElement("h2"); title.textContent = `Memo plan: ${run.model_selection ?? "memo"}`; plan.append(title); for (const step of run.task_plan) { const item = document.createElement("p"); item.textContent = `${step.title} | ${step.worker} | ${step.state}`; plan.append(item) } conversation.append(plan) }
  conversation.append(renderMemory(project))
  if (!chat) {
    const empty = document.createElement("div"); empty.className = "empty"; const label = document.createElement("span"); label.textContent = "MEMO / 01"; const heading = document.createElement("h2"); heading.textContent = project ? "Create a focused chat." : "Plan, build, verify."; const description = document.createElement("p"); description.textContent = project ? "Each chat belongs to one project and is persisted locally." : "Create a project to begin a persistent local conversation."; empty.append(label, heading, description); conversation.append(empty)
    return
  }
  if (!chat.messages.length) {
    const empty = document.createElement("div"); empty.className = "empty compact"
    const label = document.createElement("span"); label.textContent = "NEW CONVERSATION"
    const heading = document.createElement("h2"); heading.textContent = "What are we making?"
    const description = document.createElement("p"); description.textContent = "Describe a task. Memo will keep the project context local until an approved execution run begins."
    empty.append(label, heading, description); conversation.append(empty)
  }
  for (const message of chat.messages) {
    const article = document.createElement("article")
    article.className = `message ${message.role}`
    const label = document.createElement("span")
    label.textContent = message.role === "user" ? "YOU" : "MEMO"
    const content = document.createElement("p")
    content.textContent = message.content
    article.append(label, content)
    conversation.append(article)
  }
  if (run && state.deltas.get(run.id)) {
    const article = document.createElement("article")
    article.className = "message assistant streaming"
    const label = document.createElement("span")
    label.textContent = "MEMO / WORKING"
    const content = document.createElement("p")
    content.textContent = state.deltas.get(run.id)
    article.append(label, content)
    conversation.append(article)
  }
  const permissions = state.workspace.pending_permissions.filter((item) => item.run_id === run?.id)
  const permission = permissions[0]
  if (permission && !$("#permission-dialog").open) {
    state.permissionFocus = document.activeElement
    $("#permission-description").textContent = permission.title
    $("#permission-type").textContent = permission.operation_type
    $("#permission-target").textContent = permission.target || "Not specified"
    $("#permission-dialog").showModal()
  }
  conversation.scrollTop = conversation.scrollHeight
}

const loadMemory = async () => { const projectID = state.projectID; const memory = projectID ? await request(`/api/projects/${encodeURIComponent(projectID)}/memory`) : null; if (state.projectID === projectID) state.memory = memory }
const refresh = async () => {
  const previousChatID = state.chatID
  state.workspace = await request("/api/workspace")
  if (!state.workspace.projects.some((project) => project.id === state.projectID)) state.projectID = state.workspace.projects[0]?.id ?? null
  if (!state.workspace.chats.some((chat) => chat.id === state.chatID && chat.project_id === state.projectID)) state.chatID = state.workspace.chats.find((chat) => chat.project_id === state.projectID)?.id ?? null
  await loadMemory()
  if (state.chatID !== previousChatID) connectEvents()
  render()
}

$("#new-project").onclick = () => $("#project-dialog").showModal()
$("#cancel-project").onclick = () => $("#project-dialog").close()
$("#project-form").onsubmit = async (event) => {
  event.preventDefault()
  try {
    const project = await request("/api/projects", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) })
    state.projectID = project.id; state.chatID = null; $("#project-dialog").close(); await refresh()
  } catch (error) { $("#project-error").textContent = error.message }
}
$("#new-chat").onclick = () => { $("#chat-error").textContent = ""; $("#chat-dialog").showModal() }
$("#cancel-chat").onclick = () => $("#chat-dialog").close()
$("#chat-form").onsubmit = async (event) => {
  event.preventDefault()
  try {
    const chat = await request("/api/chats", { method: "POST", body: JSON.stringify({ project_id: state.projectID, ...Object.fromEntries(new FormData(event.currentTarget)) }) })
    $("#chat-dialog").close(); state.chatID = chat.id; connectEvents(); await refresh()
  } catch (error) { $("#chat-error").textContent = error.message }
}
$("#composer").onsubmit = async (event) => {
  event.preventDefault()
  const input = $("#message")
  if (!input.value.trim()) return
  try {
    $("#send").disabled = true
    state.pendingContent = input.value
    $("#execution-content").value = state.pendingContent.slice(0, 1000)
    $("#execution-project").textContent = selectedProject()?.name ?? "Unknown"
    $("#execution-chat").textContent = selectedChat()?.title ?? "Unknown"
    $("#execution-route").textContent = "Checking..."
    $("#execution-status").textContent = "Checking..."
    $("#execution-error").textContent = ""
    $("#execution-dialog").showModal()
    request("/api/plan", { method: "POST", body: JSON.stringify({ content: state.pendingContent, model: $("#model").value }) }).then((plan) => { $("#execution-route").textContent = `${plan.route}${plan.requires_approval ? " (approval required)" : ""}` }).catch(() => { $("#execution-route").textContent = "Route unavailable" })
    request("/api/opencode/status").then((status) => { $("#execution-status").textContent = !status.configured ? "Not configured" : status.reachable ? `Reachable${status.version ? ` (${status.version})` : ""}` : "Configured but unreachable" }).catch(() => { $("#execution-status").textContent = "Status unavailable" })
  } finally { $("#send").disabled = false }
}
$("#stop").onclick = async () => { try { await request(`/api/runs/${latestRun(selectedChat()).id}/stop`, { method: "POST", body: "{}" }); await refresh() } catch (error) { showError(error) } }
$("#review-approval").onclick = async () => {
  try {
    const approval = await request(`/api/runs/${latestRun(selectedChat()).id}/approval`)
    state.approval = approval; $("#approval-content").value = approval.content; $("#approval-route").textContent = approval.required_route; $("#approval-risks").textContent = approval.risk_categories.join(", "); $("#approval-error").textContent = ""; $("#approval-dialog").showModal()
  } catch (error) { showError(error) }
}
$("#retry").onclick = async () => { try { await request(`/api/runs/${latestRun(selectedChat()).id}/retry`, { method: "POST", body: "{}" }); await refresh() } catch (error) { showError(error) } }
$("#resume").onclick = async () => { try { await request(`/api/chats/${state.chatID}/resume`, { method: "POST", body: "{}" }); state.error = "Session resumed."; render() } catch (error) { showError(error) } }
$("#cancel-execution").onclick = () => $("#execution-dialog").close()
$("#cancel-approval").onclick = async () => { try { await request(`/api/runs/${state.approval.run_id}/approval/cancel`, { method: "POST", body: "{}" }); $("#approval-dialog").close(); await refresh() } catch (error) { $("#approval-error").textContent = error.message } }
$("#approval-form").onsubmit = async (event) => {
  event.preventDefault()
  try { await request(`/api/runs/${state.approval.run_id}/approve`, { method: "POST", body: JSON.stringify(state.approval) }); $("#approval-dialog").close(); await refresh() } catch (error) { $("#approval-error").textContent = error.message }
}
$("#execution-form").onsubmit = async (event) => {
  event.preventDefault()
  try {
    await request(`/api/chats/${state.chatID}/runs`, { method: "POST", body: JSON.stringify({ content: state.pendingContent, model: $("#model").value }) })
    $("#message").value = ""; $("#execution-dialog").close(); state.pendingContent = ""; await refresh()
  } catch (error) { $("#execution-error").textContent = error.message }
}
const answerPermission = async (response) => {
  const permission = state.workspace.pending_permissions.find((item) => item.run_id === latestRun(selectedChat())?.id)
  if (!permission) return
  try { await request(`/api/runs/${permission.run_id}/permissions`, { method: "POST", body: JSON.stringify({ permission_id: permission.permission_id, response }) }); $("#permission-dialog").close(); state.permissionFocus?.focus?.(); state.permissionFocus = null; await refresh() } catch (error) { showError(error) }
}
$("#permission-form").onsubmit = (event) => { event.preventDefault(); answerPermission("once") }
$("#reject-permission").onclick = () => answerPermission("reject")
$("#cancel-memory-edit").onclick = () => $("#memory-edit-dialog").close()
$("#memory-edit-form").onsubmit = async (event) => {
  event.preventDefault()
  try {
    await request(`/api/projects/${encodeURIComponent(state.projectID)}/memory/${encodeURIComponent(state.editingMemoryID)}`, { method: "PUT", body: JSON.stringify({ content: $("#memory-edit-content").value, source: $("#memory-edit-source").value, invalidation_condition: $("#memory-edit-condition").value, confidence: $("#memory-edit-confidence").value }) })
    $("#memory-edit-dialog").close(); state.editingMemoryID = null; await loadMemory(); render()
  } catch (error) { $("#memory-edit-error").textContent = error.message }
}

refresh().catch((error) => { $("#conversation").textContent = `Unable to load Memo: ${error.message}` })
