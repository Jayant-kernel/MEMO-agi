const state = { workspace: null, projectID: null, chatID: null }
const $ = (selector) => document.querySelector(selector)

const request = async (path, options = {}) => {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || "Request failed.")
  return data
}

const selectedProject = () => state.workspace.projects.find((project) => project.id === state.projectID)
const selectedChat = () => state.workspace.chats.find((chat) => chat.id === state.chatID)

const render = () => {
  const project = selectedProject()
  const chat = selectedChat()
  $("#project-list").replaceChildren(...state.workspace.projects.map((candidate) => {
    const projectButton = document.createElement("button")
    projectButton.className = `project ${candidate.id === state.projectID ? "selected" : ""}`
    projectButton.textContent = candidate.name
    projectButton.onclick = () => { state.projectID = candidate.id; state.chatID = state.workspace.chats.find((item) => item.project_id === candidate.id)?.id ?? null; render() }
    const chats = state.workspace.chats.filter((item) => item.project_id === candidate.id).map((item) => {
      const chatButton = document.createElement("button")
      chatButton.className = `chat ${item.id === state.chatID ? "selected" : ""}`
      chatButton.textContent = item.title
      chatButton.onclick = () => { state.projectID = candidate.id; state.chatID = item.id; render() }
      return chatButton
    })
    const group = document.createElement("div")
    group.className = "project-group"
    group.append(projectButton, ...chats)
    return group
  }))
  $("#project-path").textContent = project?.root ?? "LOCAL WORKSPACE"
  $("#chat-title").textContent = chat?.title ?? (project ? "No chat selected" : "Choose a project")
  $("#new-chat").disabled = !project
  $("#message").disabled = !chat
  $("#send").disabled = !chat
  const conversation = $("#conversation")
  conversation.replaceChildren()
  if (!chat) {
    conversation.innerHTML = `<div class="empty"><span>MEMO / 01</span><h2>${project ? "Create a focused chat." : "Plan, build, verify."}</h2><p>${project ? "Each chat belongs to one project and is persisted locally." : "Create a project to begin a persistent local conversation."}</p></div>`
    return
  }
  if (!chat.messages.length) conversation.innerHTML = `<div class="empty compact"><span>NEW CONVERSATION</span><h2>What are we making?</h2><p>Describe a task. Memo will keep the project context local until an approved execution run begins.</p></div>`
  for (const message of chat.messages) {
    const article = document.createElement("article")
    article.className = `message ${message.role}`
    article.innerHTML = `<span>${message.role === "user" ? "YOU" : "MEMO"}</span><p></p>`
    article.querySelector("p").textContent = message.content
    conversation.append(article)
  }
  conversation.scrollTop = conversation.scrollHeight
}

const refresh = async () => { state.workspace = await request("/api/workspace"); render() }

$("#new-project").onclick = () => $("#project-dialog").showModal()
$("#cancel-project").onclick = () => $("#project-dialog").close()
$("#project-form").onsubmit = async (event) => {
  event.preventDefault()
  const form = new FormData(event.currentTarget)
  try {
    const project = await request("/api/projects", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) })
    state.projectID = project.id
    state.chatID = null
    $("#project-dialog").close()
    await refresh()
  } catch (error) { $("#project-error").textContent = error.message }
}
$("#new-chat").onclick = async () => {
  const title = window.prompt("Chat title", "New conversation")
  if (!title) return
  const chat = await request("/api/chats", { method: "POST", body: JSON.stringify({ project_id: state.projectID, title }) })
  state.chatID = chat.id
  await refresh()
}
$("#composer").onsubmit = async (event) => {
  event.preventDefault()
  const input = $("#message")
  if (!input.value.trim()) return
  await request("/api/messages", { method: "POST", body: JSON.stringify({ chat_id: state.chatID, content: input.value }) })
  input.value = ""
  await refresh()
}

refresh().catch((error) => { $("#conversation").textContent = `Unable to load Memo: ${error.message}` })
