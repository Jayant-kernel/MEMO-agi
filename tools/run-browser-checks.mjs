import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium } from "@playwright/test"
import { createMemoServer } from "../app/server.mjs"
import { MemoBridge } from "../app/bridge.mjs"
import { MemoEvents } from "../app/events.mjs"

const evidenceDirectory = join(process.cwd(), ".memo", "browser-evidence")
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 390, height: 844 },
]
const failures = []
const screenshots = []
let checkCount = 0

const check = (condition, message) => {
  checkCount += 1
  if (!condition) failures.push(message)
}
const attempt = async (name, action) => {
  try { await action() } catch (error) { check(false, `${name}: ${error.message}`) }
}
const executableCandidates = () => {
  if (process.env.MEMO_BROWSER_EXECUTABLE) return [process.env.MEMO_BROWSER_EXECUTABLE]
  const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean)
  return [...roots.map((root) => join(root, "Google", "Chrome", "Application", "chrome.exe")), chromium.executablePath()]
}
const executablePath = async () => {
  for (const candidate of executableCandidates()) {
    try { await access(candidate, constants.X_OK); return candidate } catch {}
  }
  const override = process.env.MEMO_BROWSER_EXECUTABLE
  throw new Error(override ? `MEMO_BROWSER_EXECUTABLE does not point to an executable: ${override}` : "No Chrome or Playwright Chromium executable was found. Install Chrome or set MEMO_BROWSER_EXECUTABLE.")
}
const namedControls = async (page) => page.locator("input, textarea").evaluateAll((controls) => controls.filter((control) => {
  const labelledBy = control.getAttribute("aria-labelledby")?.split(/\s+/).some((id) => document.getElementById(id)?.textContent?.trim())
  const explicitLabel = control.id && document.querySelector(`label[for="${CSS.escape(control.id)}"]`)
  return !(control.getAttribute("aria-label")?.trim() || labelledBy || explicitLabel || control.closest("label") || control.getAttribute("placeholder")?.trim())
}).map((control) => control.id || control.outerHTML))
const unnamedButtons = async (page) => page.locator("button").evaluateAll((buttons) => buttons.filter((button) => !(button.getAttribute("aria-label")?.trim() || button.getAttribute("aria-labelledby")?.trim() || button.textContent?.trim() || button.title?.trim())).map((button) => button.id || button.outerHTML))
const closeServer = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))

let holdSession = false, releaseSession = null, releasePrompt = null, failPrompt = false
const fakeAdapter = {
  status: async () => ({ configured: true, reachable: true, version: "fake-browser" }),
  ensureAvailable: () => {},
  createSession: async () => holdSession ? new Promise((resolve) => { releaseSession = resolve }) : "session-browser",
  prompt: async () => { if (failPrompt) throw new Error("Browser fake failure") ; return new Promise((resolve) => { releasePrompt = resolve }) },
  abort: async () => { releasePrompt?.({ text: "Stopped.", upstream_message_id: "assistant-stopped" }); releasePrompt = null },
  listMessages: async () => [],
  replyPermission: async () => {},
}

await mkdir(evidenceDirectory, { recursive: true })
const workspace = await mkdtemp(join(tmpdir(), "memo-browser-checks-"))
let server
let browser
try {
  const executable = await executablePath()
  const events = new MemoEvents()
  const bridge = new MemoBridge(fakeAdapter)
  server = createMemoServer(workspace, { adapter: fakeAdapter, bridge, events })
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const address = server.address()
  const baseURL = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ executablePath: executable, headless: true })

  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } })
    const page = await context.newPage()
    const consoleErrors = []
    const pageErrors = []
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()) })
    page.on("pageerror", (error) => pageErrors.push(error.message))
    await attempt(`${viewport.name} page load`, async () => {
      const response = await page.goto(baseURL, { waitUntil: "networkidle" })
      check(response?.ok(), `${viewport.name} page did not return a successful response`)
      check(await page.locator("h1").count() === 1, `${viewport.name} page did not render its heading`)
      if (viewport.name !== "desktop") {
        check(await page.locator(".project.selected").count() === 1, `${viewport.name} did not restore a selected project`)
        check(await page.locator(".chat.selected").count() === 1, `${viewport.name} did not restore a selected chat`)
        check(!(await page.locator("#message").isDisabled()), `${viewport.name} composer stayed disabled after restoring a chat`)
      }
    })

    if (viewport.name === "desktop") {
      await attempt("create isolated project and empty chat", async () => {
        await page.getByRole("button", { name: "New project" }).click()
        await page.locator("#project-dialog input[name=name]").fill("Browser checks")
        await page.locator("#project-dialog input[name=path]").fill(".")
        await page.getByRole("button", { name: "Create project" }).click()
        await page.getByRole("button", { name: "New chat" }).click()
        await page.locator("#chat-dialog input[name=title]").fill("Empty chat")
        await page.getByRole("button", { name: "Create chat" }).click()
        await page.locator(".memory-panel").waitFor()
      })
      await attempt("empty chat memory panel", async () => {
        check(await page.locator(".memory-panel").isVisible(), "memory panel is not visible for an empty selected chat")
        check((await page.locator(".memory-status").textContent())?.includes("Collection disabled"), "memory panel does not show disabled-by-default state")
        for (const name of ["Memory note", "Memory source", "Memory invalidation condition"]) check(await page.getByRole("textbox", { name }).count() === 1, `memory field is not accessible: ${name}`)
      })
      await attempt("memory collection, edit, and 204 delete", async () => {
        await page.getByRole("button", { name: "Enable collection" }).click()
        await page.getByRole("button", { name: "Disable collection" }).waitFor()
        await page.getByRole("button", { name: "Disable collection" }).click()
        await page.getByRole("button", { name: "Enable collection" }).waitFor()
        await page.getByRole("textbox", { name: "Memory note" }).fill("Delete this browser-check note.")
        await page.getByRole("textbox", { name: "Memory source" }).fill("Browser check")
        await page.getByRole("textbox", { name: "Memory invalidation condition" }).fill("The browser check ends.")
        await page.getByRole("button", { name: "Create note" }).click()
        await page.locator(".memory-record").waitFor()
        check(await page.locator(".memory-record").count() === 1, "memory note was not created")
        await page.getByRole("button", { name: "Edit" }).click()
        await page.locator("#memory-edit-dialog").waitFor({ state: "visible" })
        await page.locator("#memory-edit-content").fill("Updated browser-check note.")
        await page.getByRole("button", { name: "Save note" }).click()
        await page.getByText("Updated browser-check note.").waitFor()
        await page.getByRole("button", { name: "Delete" }).click()
        await page.locator(".memory-record").waitFor({ state: "detached" })
        check(await page.locator(".memory-record").count() === 0, "memory note was not removed after a 204 response")
        check(!(await page.locator("#run-status").textContent())?.includes("JSON"), "memory deletion surfaced a JSON response error")
      })
      await attempt("execution dialog content and focus", async () => {
        const invoker = page.locator("#send")
        await page.locator("#message").fill("Summarize the local workspace.")
        await invoker.click()
        await page.locator("#execution-dialog").waitFor({ state: "visible" })
        await page.waitForFunction(() => document.querySelector("#execution-route")?.textContent !== "Checking..." && document.querySelector("#execution-status")?.textContent !== "Checking...")
        check((await page.locator("#execution-project").textContent()) === "Browser checks", "execution dialog project is missing")
        check((await page.locator("#execution-chat").textContent()) === "Empty chat", "execution dialog chat is missing")
        check((await page.locator("#execution-route").textContent()) === "frontier-orchestrator", "execution dialog did not show the server route")
        check((await page.locator("#execution-status").textContent()) === "Reachable (fake-browser)", "execution dialog did not show server status")
        check(await page.locator("#execution-content").inputValue() === "Summarize the local workspace.", "execution dialog request preview is missing")
        check(await page.evaluate(() => document.activeElement?.closest("dialog")?.id === "execution-dialog"), "keyboard focus did not enter the execution dialog")
        await page.getByRole("button", { name: "Cancel" }).click()
        await page.locator("#execution-dialog").waitFor({ state: "hidden" })
        check(await page.evaluate(() => document.activeElement?.id === "send"), "keyboard focus did not return to the execution invoker")
      })
      const controlsFor = async (status, action) => {
        await action()
        await page.locator(`#run-status:text-is("Run ${status}")`).waitFor()
        check(await page.locator("#send").isDisabled(), `Run Memo remains enabled while ${status}`)
        check(await page.locator("#stop").isVisible(), `Stop is hidden while ${status}`)
        check(await page.locator("#retry").isHidden(), `Retry is visible while ${status}`)
      }
      await attempt("active run controls and retry behavior", async () => {
        holdSession = true
        await page.locator("#message").fill("Keep this run pending.")
        await page.locator("#send").click()
        await page.getByRole("button", { name: "Start execution" }).click()
        await controlsFor("pending", async () => {})
        await page.locator("#stop").click()
        await page.locator("#run-status:text-is('Run cancelled')").waitFor()
        holdSession = false; releaseSession?.("session-browser"); releaseSession = null
        check(await page.locator("#retry").isVisible(), "Retry is hidden after cancellation")
        check(await page.locator("#stop").isHidden(), "Stop remains visible after cancellation")
        failPrompt = true
        await page.locator("#retry").click()
        await page.locator("#run-status").filter({ hasText: "Run failed" }).waitFor()
        check(await page.locator("#retry").isVisible(), "Retry is hidden after failure")
        check(await page.locator("#stop").isHidden(), "Stop is visible after failure")
        failPrompt = false
        await page.locator("#retry").click()
        await controlsFor("running", async () => {})
        const running = (await (await fetch(`${baseURL}/api/workspace`)).json()).runs.at(-1)
        await bridge.handleAdapterEvent(workspace, running.id, { type: "permission.requested", session_id: "session-browser", permission_id: "permission-browser", title: "Read README", operation_type: "read", target: "README.md" }, (event) => events.publish(running.chat_id, event))
        await controlsFor("awaiting_permission", async () => {})
        await page.getByRole("button", { name: "Reject" }).click()
        await page.locator("#permission-dialog").waitFor({ state: "hidden" })
        await page.locator("#stop").click()
        await page.locator("#run-status:text-is('Run cancelled')").waitFor()
      })
      await attempt("high-risk approval dialog and supervision controls", async () => {
        await page.locator("#message").fill("Review authentication and payment security before launch.")
        await page.locator("#send").click()
        await page.locator("#execution-dialog").waitFor({ state: "visible" })
        await page.getByRole("button", { name: "Start execution" }).click()
        await controlsFor("awaiting_supervision", async () => {})
        await page.locator("#review-approval").waitFor({ state: "visible" })
        await page.getByRole("button", { name: "Review approval" }).click()
        await page.locator("#approval-dialog").waitFor({ state: "visible" })
        check((await page.locator("#approval-route").textContent()) === "codex-supervisor", "approval dialog did not show the required route")
        const risks = await page.locator("#approval-risks").textContent()
        check(risks?.includes("authentication") && risks.includes("payments") && risks.includes("security"), "approval dialog did not show high-risk categories")
        await page.getByRole("button", { name: "Cancel run" }).click()
        await page.locator("#approval-dialog").waitFor({ state: "hidden" })
        await page.locator("#send:not([disabled])").waitFor()
      })
      await attempt("permission dialog resolves sequentially and restores focus", async () => {
        await page.locator("#message").fill("Request permissions.")
        await page.locator("#send").click()
        await page.getByRole("button", { name: "Start execution" }).click()
        await page.locator("#run-status").filter({ hasText: "Run running" }).waitFor()
        const running = (await (await fetch(`${baseURL}/api/workspace`)).json()).runs.at(-1)
        await page.locator("#stop").focus()
        await bridge.handleAdapterEvent(workspace, running.id, { type: "permission.requested", session_id: "session-browser", permission_id: "permission-first-browser", title: "Read first", operation_type: "read", target: "first.txt" }, (event) => events.publish(running.chat_id, event))
        await bridge.handleAdapterEvent(workspace, running.id, { type: "permission.requested", session_id: "session-browser", permission_id: "permission-second-browser", title: "Read second", operation_type: "read", target: "second.txt" }, (event) => events.publish(running.chat_id, event))
        await page.locator("#permission-dialog").waitFor({ state: "visible" })
        await page.getByRole("button", { name: "Allow once" }).click()
        await page.locator("#permission-description:text-is('Read second')").waitFor()
        await page.getByRole("button", { name: "Reject" }).click()
        await page.locator("#permission-dialog").waitFor({ state: "hidden" })
        check(await page.evaluate(() => document.activeElement?.id === "stop"), "permission dialog did not restore focus to its invoker")
        await page.locator("#stop").click()
      })
    }

    if (viewport.name === "mobile") {
      await attempt("mobile execution dialog bounds", async () => {
        await page.getByRole("button", { name: "Empty chat" }).click()
        await page.locator("#message:not([disabled])").waitFor()
        await page.locator("#message").fill("Check the compact dialog.")
        await page.locator("#send").click()
        await page.locator("#execution-dialog").waitFor({ state: "visible" })
        const bounds = await page.locator("#execution-dialog").boundingBox()
        check(Boolean(bounds) && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height, "mobile execution dialog extends outside the viewport")
        await page.getByRole("button", { name: "Cancel" }).click()
      })
    }

    await attempt(`${viewport.name} accessibility and layout`, async () => {
      check((await namedControls(page)).length === 0, `${viewport.name} has unnamed inputs or textareas: ${(await namedControls(page)).join(", ")}`)
      check((await unnamedButtons(page)).length === 0, `${viewport.name} has unnamed buttons: ${(await unnamedButtons(page)).join(", ")}`)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth || document.body.scrollWidth > window.innerWidth)
      check(!overflow, `${viewport.name} has horizontal overflow`)
      check(pageErrors.length === 0, `${viewport.name} page errors: ${pageErrors.join(" | ")}`)
      check(consoleErrors.length === 0, `${viewport.name} console errors: ${consoleErrors.join(" | ")}`)
    })
    const screenshot = join(evidenceDirectory, `${viewport.name}.png`)
    await page.screenshot({ path: screenshot, fullPage: true })
    screenshots.push(screenshot)
    await context.close()
  }
} catch (error) {
  failures.push(error.message)
} finally {
  await browser?.close().catch((error) => failures.push(`browser shutdown: ${error.message}`))
  await (server ? closeServer(server) : Promise.resolve()).catch((error) => failures.push(`server shutdown: ${error.message}`))
  await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
}

const report = { passed: failures.length === 0, checks: checkCount, failures, screenshots }
const reportPath = join(evidenceDirectory, "report.json")
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ passed: report.passed, checks: report.checks, failures: report.failures.length, report: reportPath, screenshots: screenshots.map((path) => path.replace(`${evidenceDirectory}\\`, "")) }))
if (!report.passed) process.exitCode = 1
