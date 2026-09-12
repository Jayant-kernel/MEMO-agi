import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { addMessage, createChat, createProject, getWorkspace } from "./workspace.mjs"

const appDirectory = dirname(fileURLToPath(import.meta.url))
const publicDirectory = join(appDirectory, "public")
const files = { "/": ["index.html", "text/html; charset=utf-8"], "/app.js": ["app.js", "application/javascript; charset=utf-8"], "/styles.css": ["styles.css", "text/css; charset=utf-8"] }

const send = (response, status, payload) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  response.end(JSON.stringify(payload))
}

const readBody = async (request) => new Promise((resolveBody, reject) => {
  let body = ""
  request.setEncoding("utf8")
  request.on("data", (chunk) => {
    body += chunk
    if (body.length > 65536) reject(new Error("Request body is too large."))
  })
  request.on("end", () => {
    try { resolveBody(body ? JSON.parse(body) : {}) } catch { reject(new Error("Request body must be JSON.")) }
  })
  request.on("error", reject)
})

export const createMemoServer = (directory) => createServer(async (request, response) => {
  try {
    if (request.method === "GET" && files[request.url]) {
      const [file, contentType] = files[request.url]
      response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" })
      response.end(await readFile(join(publicDirectory, file)))
      return
    }
    if (request.method === "GET" && request.url === "/api/workspace") return send(response, 200, await getWorkspace(directory))
    const body = await readBody(request)
    if (request.method === "POST" && request.url === "/api/projects") return send(response, 201, await createProject(directory, body))
    if (request.method === "POST" && request.url === "/api/chats") return send(response, 201, await createChat(directory, body))
    if (request.method === "POST" && request.url === "/api/messages") return send(response, 201, await addMessage(directory, body))
    return send(response, 404, { error: "Route not found." })
  } catch (error) {
    return send(response, 400, { error: error.message || "Request failed." })
  }
})

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const port = Number(process.env.MEMO_PORT ?? 4173)
  const server = createMemoServer(process.cwd())
  server.listen(port, "127.0.0.1", () => console.log(`Memo is available at http://127.0.0.1:${port}`))
}
