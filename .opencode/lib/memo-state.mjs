import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"

const RUN_STATUSES = new Set(["running", "passed", "failed", "blocked", "cancelled"])
const EVENT_TYPES = new Set(["note", "route", "delegation", "tool", "check", "failure", "checkpoint"])

const now = () => new Date().toISOString()
const statePath = (directory) => join(resolve(directory), ".memo")
const runPath = (directory, runID) => join(statePath(directory), "runs", `${runID}.json`)
const eventPath = (directory, runID) => join(statePath(directory), "runs", `${runID}.events.jsonl`)
const manifestPath = (directory, taskID) => join(statePath(directory), "tasks", `${taskID}.json`)

const assertID = (value, label) => {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{2,79}$/i.test(value)) {
    throw new Error(`${label} must contain 3-80 letters, numbers, underscores, or hyphens.`)
  }
}

const assertText = (value, label, maxLength) => {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} must be non-empty and no longer than ${maxLength} characters.`)
  }
}

const assertStringList = (value, label, maxItems) => {
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be a list of up to ${maxItems} non-empty strings.`)
  }
}

const writeJSON = async (path, value) => {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  await rename(temporary, path)
}

const readJSON = async (path) => JSON.parse(await readFile(path, "utf8"))

const ensureState = async (directory) => {
  const root = statePath(directory)
  await Promise.all([mkdir(join(root, "runs"), { recursive: true }), mkdir(join(root, "tasks"), { recursive: true }), mkdir(join(root, "evals"), { recursive: true })])
  return root
}

export const createRun = async (directory, input) => {
  assertText(input.task, "task", 4000)
  assertText(input.route, "route", 100)
  assertStringList(input.models ?? [], "models", 10)
  await ensureState(directory)

  const runID = input.run_id ?? `run-${randomUUID()}`
  assertID(runID, "run_id")
  const timestamp = now()
  const run = {
    schema_version: 1,
    run_id: runID,
    project: basename(resolve(directory)),
    task: input.task.trim(),
    route: input.route.trim(),
    models: input.models ?? [],
    task_id: input.task_id ?? null,
    status: "running",
    started_at: timestamp,
    finished_at: null,
    duration_ms: null,
    token_estimate: { input: null, output: null },
    tool_calls: 0,
    delegations: 0,
    checks: { passed: 0, failed: 0 },
    failure_count: 0,
  }
  await writeJSON(runPath(directory, runID), run)
  return run
}

export const recordRunEvent = async (directory, input) => {
  assertID(input.run_id, "run_id")
  if (!EVENT_TYPES.has(input.type)) throw new Error("type must be note, route, delegation, tool, check, failure, or checkpoint.")
  assertText(input.summary, "summary", 4000)
  const path = runPath(directory, input.run_id)
  const run = await readJSON(path)
  if (run.status !== "running") throw new Error(`Cannot add an event to a ${run.status} run.`)

  const event = {
    at: now(),
    type: input.type,
    summary: input.summary.trim(),
    model: input.model ?? null,
    duration_ms: input.duration_ms ?? null,
    tokens: input.tokens ?? null,
    evidence: input.evidence ?? [],
  }
  if (event.type === "tool") run.tool_calls += 1
  if (event.type === "delegation") run.delegations += 1
  if (event.type === "failure") run.failure_count += 1
  if (event.type === "check") {
    const outcome = input.outcome ?? "passed"
    if (outcome === "passed") run.checks.passed += 1
    else if (outcome === "failed") run.checks.failed += 1
    else throw new Error("A check event outcome must be passed or failed.")
    event.outcome = outcome
  }
  if (event.tokens) {
    run.token_estimate.input = (run.token_estimate.input ?? 0) + (event.tokens.input ?? 0)
    run.token_estimate.output = (run.token_estimate.output ?? 0) + (event.tokens.output ?? 0)
  }
  await appendFile(eventPath(directory, input.run_id), `${JSON.stringify(event)}\n`, "utf8")
  await writeJSON(path, run)
  return event
}

export const finishRun = async (directory, input) => {
  assertID(input.run_id, "run_id")
  if (!RUN_STATUSES.has(input.status) || input.status === "running") throw new Error("status must be passed, failed, blocked, or cancelled.")
  const path = runPath(directory, input.run_id)
  const run = await readJSON(path)
  if (run.status !== "running") throw new Error(`Run is already ${run.status}.`)
  run.status = input.status
  run.finished_at = now()
  run.duration_ms = Date.parse(run.finished_at) - Date.parse(run.started_at)
  run.outcome = input.outcome?.trim() || null
  await writeJSON(path, run)
  return run
}

export const createManifest = async (directory, input) => {
  assertID(input.task_id, "task_id")
  assertText(input.title, "title", 300)
  assertText(input.request, "request", 8000)
  assertStringList(input.acceptance_criteria, "acceptance_criteria", 30)
  assertStringList(input.verification, "verification", 30)
  await ensureState(directory)
  const timestamp = now()
  const manifest = {
    schema_version: 1,
    task_id: input.task_id,
    title: input.title.trim(),
    request: input.request.trim(),
    risk: input.risk ?? "standard",
    route: input.route ?? null,
    acceptance_criteria: input.acceptance_criteria.map((item) => item.trim()),
    verification: input.verification.map((item) => item.trim()),
    checkpoints: [],
    status: "planned",
    created_at: timestamp,
    updated_at: timestamp,
  }
  await writeJSON(manifestPath(directory, input.task_id), manifest)
  return manifest
}

export const addCheckpoint = async (directory, input) => {
  assertID(input.task_id, "task_id")
  assertText(input.summary, "summary", 4000)
  const path = manifestPath(directory, input.task_id)
  const manifest = await readJSON(path)
  const checkpoint = { at: now(), status: input.status ?? "in_progress", summary: input.summary.trim(), evidence: input.evidence ?? [] }
  manifest.checkpoints.push(checkpoint)
  manifest.status = checkpoint.status
  manifest.updated_at = checkpoint.at
  await writeJSON(path, manifest)
  return manifest
}

export const getMemoState = async (directory, input) => {
  await ensureState(directory)
  if (input.run_id) return readJSON(runPath(directory, input.run_id))
  if (input.task_id) return readJSON(manifestPath(directory, input.task_id))
  throw new Error("Specify run_id or task_id.")
}

export const memoPaths = { statePath, runPath, eventPath, manifestPath }
