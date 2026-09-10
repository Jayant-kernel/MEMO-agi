import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import test from "node:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addCheckpoint, createManifest, createRun, finishRun, memoPaths, recordRunEvent } from "../.opencode/lib/memo-state.mjs"

const withProject = async (callback) => {
  const directory = await mkdtemp(join(tmpdir(), "memo-state-"))
  try { await callback(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

test("creates a run and accumulates trace metrics", async () => withProject(async (directory) => {
  const run = await createRun(directory, { run_id: "run-foundation", task: "Verify state storage", route: "local", models: ["ollama/qwen3.5:9b"] })
  assert.equal(run.status, "running")
  await recordRunEvent(directory, { run_id: run.run_id, type: "tool", summary: "Read configuration", tokens: { input: 12, output: 8 } })
  await recordRunEvent(directory, { run_id: run.run_id, type: "check", summary: "Unit test passed", outcome: "passed" })
  const finished = await finishRun(directory, { run_id: run.run_id, status: "passed", outcome: "Verified." })
  assert.equal(finished.tool_calls, 1)
  assert.equal(finished.checks.passed, 1)
  assert.equal(finished.token_estimate.input, 12)
  assert.equal(finished.status, "passed")
  const events = await readFile(memoPaths.eventPath(directory, run.run_id), "utf8")
  assert.equal(events.trim().split("\n").length, 2)
}))

test("creates a manifest with resumable checkpoints", async () => withProject(async (directory) => {
  await createManifest(directory, { task_id: "task-foundation", title: "Foundation", request: "Create state tooling", acceptance_criteria: ["Tests pass"], verification: ["Run node tests"] })
  const manifest = await addCheckpoint(directory, { task_id: "task-foundation", status: "in_progress", summary: "State module created", evidence: ["test/memo-state.test.mjs"] })
  assert.equal(manifest.status, "in_progress")
  assert.equal(manifest.checkpoints.length, 1)
}))

test("rejects invalid run states", async () => withProject(async (directory) => {
  await createRun(directory, { run_id: "run-invalid", task: "Verify validation", route: "local", models: [] })
  await assert.rejects(() => finishRun(directory, { run_id: "run-invalid", status: "running" }))
}))
