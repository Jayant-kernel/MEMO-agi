import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { getWorkspace } from "./workspace.mjs"

const memoryFile = (directory) => join(resolve(directory), ".memo", "memory.json")
const lockFile = (directory) => join(resolve(directory), ".memo", "memory.lock")
const MAX_RECORDS = 200
const MAX_CONTENT = 4000
const MAX_TEXT = 500
const PROVENANCE = new Set(["user", "project-check", "external"])
const VERIFICATION = new Set(["unverified", "verified", "invalidated"])
const CONFIDENCE = new Set(["low", "medium", "high"])
const queues = new Map()
const processStartedAt = Date.now() - Math.round(process.uptime() * 1000)
const now = () => new Date().toISOString()
const replaceFile = async (temporary, file) => {
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(temporary, file); return }
    catch (error) { if (!new Set(["EPERM", "EACCES"]).has(error.code) || attempt >= 10) throw error; await new Promise((done) => setTimeout(done, 10 * (attempt + 1))) }
  }
}

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode })
const text = (value, label, maximum = MAX_TEXT) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw fail(`${label} is invalid.`)
  return value.trim()
}
const id = (value, label) => {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{2,79}$/i.test(value)) throw fail(`${label} is invalid.`)
  return value
}
const timestamp = (value, label) => {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw fail(`${label} is invalid.`)
}
const boolean = (value, label) => { if (typeof value !== "boolean") throw fail(`${label} is invalid.`) }
const secretLike = (value) => /(?:password|passwd|api[_ -]?key|access[_ -]?token|session(?:[_ -]?id)?|cookie|authorization)\s*(?:[:=]|bearer\s+)|-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|\bgh[opsru]_[A-Za-z0-9]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/i.test(value)
const safeText = (value, label, maximum) => {
  const result = text(value, label, maximum)
  if (secretLike(result)) throw fail(`${label} must not contain credentials or secrets.`)
  return result
}
const empty = () => ({ schema_version: 1, collections: [], records: [] })

const validate = async (directory, state) => {
  if (!state || typeof state !== "object" || state.schema_version !== 1 || !Array.isArray(state.collections) || !Array.isArray(state.records)) throw fail("Memory data is invalid.")
  if (state.collections.length > MAX_RECORDS || state.records.length > MAX_RECORDS) throw fail("Memory data exceeds its limit.")
  const projects = new Set((await getWorkspace(directory)).projects.map((project) => project.id))
  const collections = new Set(), records = new Set()
  for (const collection of state.collections) {
    id(collection?.project_id, "Memory project_id"); boolean(collection?.enabled, "Memory collection enabled"); timestamp(collection?.created_at, "Memory collection created_at"); timestamp(collection?.updated_at, "Memory collection updated_at")
    if (!projects.has(collection.project_id) || collections.has(collection.project_id)) throw fail("Memory collection references are invalid.")
    collections.add(collection.project_id)
  }
  for (const record of state.records) {
    id(record?.id, "Memory record id"); if (record.scope !== "project") throw fail("Memory scope is invalid.")
    id(record?.project_id, "Memory project_id"); safeText(record?.content, "Memory content", MAX_CONTENT); safeText(record?.source, "Memory source", MAX_TEXT); safeText(record?.owner, "Memory owner", 120)
    if (!PROVENANCE.has(record?.provenance) || !VERIFICATION.has(record?.verification) || !CONFIDENCE.has(record?.confidence)) throw fail("Memory record metadata is invalid.")
    safeText(record.invalidation_condition, "Memory invalidation condition", MAX_TEXT)
    if (record.verification === "invalidated" && !record.invalidation_condition) throw fail("Invalidated memory requires an invalidation condition.")
    boolean(record?.enabled, "Memory enabled"); boolean(record?.pinned, "Memory pinned"); timestamp(record?.created_at, "Memory created_at"); timestamp(record?.updated_at, "Memory updated_at")
    if (!projects.has(record.project_id) || !collections.has(record.project_id) || records.has(record.id)) throw fail("Memory record references are invalid.")
    records.add(record.id)
  }
  return state
}
const readState = async (directory) => {
  try { return await validate(directory, JSON.parse(await readFile(memoryFile(directory), "utf8"))) }
  catch (error) { if (error.code === "ENOENT") return empty(); if (error.message?.startsWith("Memory ")) throw error; throw fail(`Memory data is invalid: ${error.message}`) }
}
const writeState = async (directory, state) => {
  const file = memoryFile(directory); await mkdir(resolve(directory, ".memo"), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8"); await replaceFile(temporary, file)
}
const acquireLock = async (directory) => {
  await mkdir(resolve(directory, ".memo"), { recursive: true }); const path = lockFile(directory); const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      const handle = await open(path, "wx"); const token = randomUUID()
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, process_started_at: processStartedAt })) }
      catch (error) { await handle.close().catch(() => {}); await rm(path, { force: true }).catch(() => {}); throw error }
      return async () => { await handle.close(); try { if (JSON.parse(await readFile(path, "utf8")).token === token) await rm(path, { force: true }) } catch (error) { if (error.code !== "ENOENT") throw error } }
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      try { const owner = JSON.parse(await readFile(path, "utf8")); let alive = Number.isInteger(owner.pid) && owner.pid > 0; if (alive) try { process.kill(owner.pid, 0) } catch (ownerError) { alive = ownerError.code === "EPERM" }; if (alive && owner.pid === process.pid && owner.process_started_at !== processStartedAt) alive = false; if (!alive && Date.now() - (await stat(path)).mtimeMs > 1000) await rm(path, { force: true }) } catch (stale) { if (stale.code === "ENOENT") continue; if (stale instanceof SyntaxError && Date.now() - (await stat(path)).mtimeMs > 30000) await rm(path, { force: true }); else if (!(stale instanceof SyntaxError)) throw stale }
      await new Promise((done) => setTimeout(done, 20))
    }
  }
  throw fail("Memory is busy; try again.", 503)
}
const mutate = (directory, change) => {
  const key = resolve(directory), previous = queues.get(key) ?? Promise.resolve()
  const queued = previous.catch(() => {}).then(async () => { const release = await acquireLock(directory); try { const state = await readState(directory); const result = await change(state); await validate(directory, state); await writeState(directory, state); return result } finally { await release() } })
  queues.set(key, queued); queued.finally(() => { if (queues.get(key) === queued) queues.delete(key) }).catch(() => {}); return queued
}
const dto = (record) => ({ id: record.id, scope: record.scope, project_id: record.project_id, content: record.content, source: record.source, provenance: record.provenance, owner: record.owner, created_at: record.created_at, updated_at: record.updated_at, verification: record.verification, confidence: record.confidence, invalidation_condition: record.invalidation_condition, enabled: record.enabled, pinned: record.pinned })
const findRecord = (state, projectID, recordID) => { const record = state.records.find((item) => item.id === id(recordID, "Memory record id") && item.project_id === id(projectID, "Memory project_id")); if (!record) throw fail("Memory record does not exist.", 404); return record }
const normalized = (value) => value.trim().replace(/\s+/g, " ").toLowerCase()
const collectionFor = (state, projectID) => state.collections.find((item) => item.project_id === projectID)
const ensureProject = async (directory, projectID) => { id(projectID, "Memory project_id"); if (!(await getWorkspace(directory)).projects.some((project) => project.id === projectID)) throw fail("Project does not exist.", 404) }
const words = (value) => new Set(normalized(value).match(/[a-z0-9]{2,}/g) ?? [])

export const listMemory = async (directory, projectID) => {
  await ensureProject(directory, projectID); const state = await readState(directory); const collection = collectionFor(state, projectID)
  return { project_id: projectID, enabled: Boolean(collection?.enabled), records: state.records.filter((record) => record.project_id === projectID).map(dto) }
}
export const retrieveMemory = async (directory, projectID, input = {}) => {
  await ensureProject(directory, projectID)
  const query = text(input.query, "Memory query", MAX_TEXT), maxRecords = input.max_records === undefined ? 10 : input.max_records, charBudget = input.char_budget === undefined ? MAX_CONTENT : input.char_budget
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 20 || !Number.isInteger(charBudget) || charBudget < 1 || charBudget > MAX_CONTENT) throw fail("Memory retrieval limits are invalid.")
  const state = await readState(directory), collection = collectionFor(state, projectID)
  if (!collection?.enabled) return { project_id: projectID, enabled: false, records: [] }
  const queryWords = words(query); let used = 0
  const records = state.records.filter((record) => record.project_id === projectID && record.enabled && record.verification !== "invalidated").map((record) => ({ record, score: [...words(`${record.content} ${record.source}`)].filter((word) => queryWords.has(word)).length + (record.pinned ? 0.5 : 0) })).filter(({ score }) => score > 0).sort((left, right) => right.score - left.score || left.record.created_at.localeCompare(right.record.created_at)).flatMap(({ record }) => {
    const size = record.content.length + record.source.length
    if (used + size > charBudget || used >= charBudget) return []
    used += size; return [dto(record)]
  }).slice(0, maxRecords)
  return { project_id: projectID, enabled: true, records }
}
export const createMemory = async (directory, input) => mutate(directory, async (state) => {
  const projectID = id(input?.project_id, "Memory project_id"); await ensureProject(directory, projectID)
  if (state.records.length >= MAX_RECORDS) throw fail("Memory record limit reached.")
  const content = safeText(input.content, "Memory content", MAX_CONTENT), source = safeText(input.source, "Memory source", MAX_TEXT)
  if (state.records.some((record) => record.project_id === projectID && normalized(record.content) === normalized(content) && normalized(record.source) === normalized(source))) throw fail("A matching memory record already exists.", 409)
  const timestampValue = now(); let collection = state.collections.find((item) => item.project_id === projectID)
  if (!collection) { collection = { project_id: projectID, enabled: true, created_at: timestampValue, updated_at: timestampValue }; state.collections.push(collection) } else { collection.enabled = true; collection.updated_at = timestampValue }
  const provenance = input.provenance; if (!PROVENANCE.has(provenance)) throw fail("Memory provenance is invalid.")
  const verification = provenance === "external" ? "unverified" : (input.verification ?? "unverified"); if (!VERIFICATION.has(verification)) throw fail("Memory verification is invalid.")
  const record = { id: `memory-${randomUUID()}`, scope: "project", project_id: projectID, content, source, provenance, owner: safeText(input.owner ?? "user", "Memory owner", 120), created_at: timestampValue, updated_at: timestampValue, verification, confidence: input.confidence ?? "medium", invalidation_condition: safeText(input.invalidation_condition, "Memory invalidation condition", MAX_TEXT), enabled: input.enabled ?? true, pinned: input.pinned ?? false }
  if (!CONFIDENCE.has(record.confidence)) throw fail("Memory confidence is invalid."); boolean(record.enabled, "Memory enabled"); boolean(record.pinned, "Memory pinned"); state.records.push(record); return dto(record)
})
export const updateMemory = async (directory, projectID, recordID, input) => mutate(directory, async (state) => {
  const record = findRecord(state, projectID, recordID); if (input.content !== undefined) record.content = safeText(input.content, "Memory content", MAX_CONTENT); if (input.source !== undefined) record.source = safeText(input.source, "Memory source", MAX_TEXT); if (input.owner !== undefined) record.owner = safeText(input.owner, "Memory owner", 120)
  if (input.provenance !== undefined) { if (!PROVENANCE.has(input.provenance)) throw fail("Memory provenance is invalid."); record.provenance = input.provenance }
  if (input.verification !== undefined) { if (!VERIFICATION.has(input.verification)) throw fail("Memory verification is invalid."); record.verification = input.verification }
  if (input.confidence !== undefined) { if (!CONFIDENCE.has(input.confidence)) throw fail("Memory confidence is invalid."); record.confidence = input.confidence }
  if (input.invalidation_condition !== undefined) record.invalidation_condition = safeText(input.invalidation_condition, "Memory invalidation condition", MAX_TEXT)
  if (input.enabled !== undefined) { boolean(input.enabled, "Memory enabled"); record.enabled = input.enabled }; if (input.pinned !== undefined) { boolean(input.pinned, "Memory pinned"); record.pinned = input.pinned }
  if (record.verification === "invalidated" && !record.invalidation_condition) throw fail("Invalidated memory requires an invalidation condition."); record.updated_at = now(); return dto(record)
})
export const invalidateMemory = async (directory, projectID, recordID, input) => updateMemory(directory, projectID, recordID, { invalidation_condition: input?.invalidation_condition, verification: "invalidated" })
export const deleteMemory = async (directory, projectID, recordID) => mutate(directory, async (state) => { const record = findRecord(state, projectID, recordID); state.records.splice(state.records.indexOf(record), 1) })
export const setMemoryPinned = async (directory, projectID, recordID, pinned) => updateMemory(directory, projectID, recordID, { pinned })
export const setMemoryEnabled = async (directory, projectID, recordID, enabled) => updateMemory(directory, projectID, recordID, { enabled })
export const setMemoryCollectionEnabled = async (directory, projectID, enabled) => mutate(directory, async (state) => {
  await ensureProject(directory, projectID); boolean(enabled, "Memory collection enabled")
  const timestampValue = now(); let collection = collectionFor(state, projectID)
  if (!collection) { collection = { project_id: projectID, enabled, created_at: timestampValue, updated_at: timestampValue }; state.collections.push(collection) }
  else { collection.enabled = enabled; collection.updated_at = timestampValue }
  return { project_id: projectID, enabled: collection.enabled }
})
