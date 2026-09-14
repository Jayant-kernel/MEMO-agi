import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProject } from "../app/workspace.mjs"
import { createMemory, deleteMemory, invalidateMemory, listMemory, retrieveMemory, setMemoryCollectionEnabled, setMemoryEnabled, setMemoryPinned, updateMemory } from "../app/memory.mjs"
import { createMemoServer } from "../app/server.mjs"

const withWorkspace = async (callback) => { const directory = await mkdtemp(join(tmpdir(), "memo-memory-")); try { await callback(directory) } finally { await rm(directory, { recursive: true, force: true }) } }
const project = (directory, name = "Memo") => createProject(directory, { name, path: "." })
const input = (projectID, extra = {}) => ({ project_id: projectID, content: "Use npm test before release.", source: "User request", provenance: "user", owner: "user", invalidation_condition: "The test command changes.", confidence: "medium", ...extra })

test("memory is disabled until explicit create enables its project collection", async () => withWorkspace(async (directory) => {
  const item = await project(directory); assert.deepEqual(await listMemory(directory, item.id), { project_id: item.id, enabled: false, records: [] })
  await createMemory(directory, input(item.id)); assert.equal((await listMemory(directory, item.id)).enabled, true)
}))

test("memory records are isolated by project and public DTOs omit roots and sessions", async () => withWorkspace(async (directory) => {
  const first = await project(directory, "First"); await mkdir(join(directory, "second")); const second = await createProject(directory, { name: "Second", path: "second" })
  const record = await createMemory(directory, input(first.id)); const listed = await listMemory(directory, first.id)
  assert.equal(listed.records.length, 1); assert.equal((await listMemory(directory, second.id)).records.length, 0)
  assert.equal("root" in listed.records[0], false); assert.equal("session_id" in listed.records[0], false); assert.equal(record.project_id, first.id)
}))

test("rejects credential-like note content and source", async () => withWorkspace(async (directory) => {
  const item = await project(directory)
  await assert.rejects(() => createMemory(directory, input(item.id, { content: "password=unsafe" })), /credentials|secrets/)
  await assert.rejects(() => createMemory(directory, input(item.id, { source: "Authorization: Bearer value" })), /credentials|secrets/)
  await assert.rejects(() => createMemory(directory, input(item.id, { content: "Use ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234567890 for release." })), /credentials|secrets/)
  await assert.rejects(() => createMemory(directory, input(item.id, { source: "AKIAIOSFODNN7EXAMPLE" })), /credentials|secrets/)
}))

test("deduplicates project memory and supports collection-controlled bounded retrieval", async () => withWorkspace(async (directory) => {
  const item = await project(directory)
  const first = await createMemory(directory, input(item.id, { content: "Run npm test before releasing Memo.", source: "Release checklist", pinned: true }))
  await createMemory(directory, input(item.id, { content: "Use npm test for unrelated checks.", source: "Development guide" }))
  await createMemory(directory, input(item.id, { content: "This record is invalid.", source: "Old guide", verification: "invalidated" }))
  await assert.rejects(() => createMemory(directory, input(item.id, { content: " run   npm TEST before releasing memo. ", source: "release checklist" })), { statusCode: 409 })
  const retrieved = await retrieveMemory(directory, item.id, { query: "npm test release", max_records: 1, char_budget: 200 })
  assert.deepEqual(retrieved.records.map((record) => record.id), [first.id])
  await setMemoryCollectionEnabled(directory, item.id, false)
  assert.deepEqual(await retrieveMemory(directory, item.id, { query: "npm test" }), { project_id: item.id, enabled: false, records: [] })
  await setMemoryCollectionEnabled(directory, item.id, true)
  await setMemoryEnabled(directory, item.id, first.id, false)
  assert.equal((await retrieveMemory(directory, item.id, { query: "npm test" })).records.some((record) => record.id === first.id), false)
}))

test("edits inspectable memory fields through the storage API", async () => withWorkspace(async (directory) => {
  const item = await project(directory); const record = await createMemory(directory, input(item.id))
  const updated = await updateMemory(directory, item.id, record.id, { content: "Run the full test suite before release.", source: "Updated release policy", confidence: "high", invalidation_condition: "The release process changes." })
  assert.deepEqual({ content: updated.content, source: updated.source, confidence: updated.confidence, invalidation_condition: updated.invalidation_condition }, { content: "Run the full test suite before release.", source: "Updated release policy", confidence: "high", invalidation_condition: "The release process changes." })
}))

test("rejects malformed persisted memory including duplicate IDs and invalid metadata", async () => withWorkspace(async (directory) => {
  const item = await project(directory); await mkdir(join(directory, ".memo"), { recursive: true })
  const valid = { schema_version: 1, collections: [{ project_id: item.id, enabled: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }], records: [] }
  await writeFile(join(directory, ".memo", "memory.json"), JSON.stringify({ ...valid, records: [{ id: "memory-one", scope: "project", project_id: item.id, content: "x", source: "user", provenance: "wrong", owner: "user", created_at: "bad", updated_at: "bad", verification: "unverified", confidence: "wrong", invalidation_condition: null, enabled: true, pinned: false }] }))
  await assert.rejects(() => listMemory(directory, item.id), /Memory .*invalid/)
  const timestamp = new Date().toISOString(); const record = { id: "memory-one", scope: "project", project_id: item.id, content: "x", source: "user", provenance: "user", owner: "user", created_at: timestamp, updated_at: timestamp, verification: "unverified", confidence: "low", invalidation_condition: "Changes", enabled: true, pinned: false }
  await writeFile(join(directory, ".memo", "memory.json"), JSON.stringify({ ...valid, records: [record, structuredClone(record)] }))
  await assert.rejects(() => listMemory(directory, item.id), /references are invalid/)
}))

test("invalidation retains its condition, deletion removes records, and toggles persist", async () => withWorkspace(async (directory) => {
  const item = await project(directory); const record = await createMemory(directory, input(item.id))
  await setMemoryPinned(directory, item.id, record.id, true); await setMemoryEnabled(directory, item.id, record.id, false)
  const invalidated = await invalidateMemory(directory, item.id, record.id, { invalidation_condition: "The release policy was replaced." })
  assert.deepEqual({ pinned: invalidated.pinned, enabled: invalidated.enabled, verification: invalidated.verification, invalidation_condition: invalidated.invalidation_condition }, { pinned: true, enabled: false, verification: "invalidated", invalidation_condition: "The release policy was replaced." })
  await deleteMemory(directory, item.id, record.id); assert.equal((await listMemory(directory, item.id)).records.length, 0)
}))

test("external records begin unverified and concurrent writes retain every record", async () => withWorkspace(async (directory) => {
  const item = await project(directory); const external = await createMemory(directory, input(item.id, { provenance: "external", verification: "verified" })); assert.equal(external.verification, "unverified")
  await Promise.all(Array.from({ length: 20 }, (_, index) => createMemory(directory, input(item.id, { content: `Note ${index}` }))))
  const records = (await listMemory(directory, item.id)).records; assert.equal(records.length, 21); assert.equal(new Set(records.map((record) => record.id)).size, 21)
}))

test("memory server routes are project-scoped and do not instantiate an adapter while browsing", async () => withWorkspace(async (directory) => {
  const item = await project(directory); let constructions = 0
  const server = createMemoServer(directory, { adapterFactory: () => { constructions += 1; return { status: async () => ({}) } } }); await new Promise((done) => server.listen(0, "127.0.0.1", done))
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/projects/${item.id}/memory`
    assert.equal((await fetch(base)).status, 200); assert.equal(constructions, 0)
    const created = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input(item.id)) }); assert.equal(created.status, 201); const record = await created.json()
    assert.equal((await fetch(`${base}/${record.id}/pin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pinned: true }) })).status, 200)
    assert.equal((await fetch(`${base}/collection`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) })).status, 200)
    const retrieval = await fetch(`${base}/retrieve?query=npm%20test&max_records=1&char_budget=200`); assert.equal(retrieval.status, 200); assert.deepEqual((await retrieval.json()).records, [])
    assert.equal((await fetch(`${base}/${record.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ confidence: "high" }) })).status, 200)
    assert.equal((await fetch(`${base}/${record.id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" })).status, 204)
    assert.equal(constructions, 0)
  } finally { await new Promise((done) => server.close(done)) }
}))

test("recovers a stale malformed memory lock", async () => withWorkspace(async (directory) => {
  const item = await project(directory)
  await mkdir(join(directory, ".memo"), { recursive: true })
  const lock = join(directory, ".memo", "memory.lock")
  await writeFile(lock, "{")
  const stale = new Date(Date.now() - 31000)
  await utimes(lock, stale, stale)
  const record = await createMemory(directory, input(item.id))
  assert.equal(record.project_id, item.id)
}))
