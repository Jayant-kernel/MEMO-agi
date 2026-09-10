import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const read = (path) => readFile(resolve(root, path), "utf8")

test("the launcher permits the Memo root and rejects outside projects", async () => {
  const source = await read("Start-Memo.ps1")
  assert.match(source, /\.Equals\(\$memoRoot/)
  assert.match(source, /StartsWith\(\$projectPrefix/)
})

test("Memo defaults to approval for external directories", async () => {
  const config = await read("opencode.jsonc")
  assert.match(config, /"external_directory": "ask"/)
})

test("workers cannot delegate and research remains read-only", async () => {
  for (const agent of ["local-worker", "luna-worker", "terra-implementer", "research-worker", "ui-quality-critic"]) {
    const source = await read(`.opencode/agents/${agent}.md`)
    assert.match(source, /task: deny/)
  }
  const research = await read(".opencode/agents/research-worker.md")
  assert.match(research, /edit: deny/)
  assert.match(research, /external_directory: ask/)
})

test("the final synthesizer has no execution permissions", async () => {
  const source = await read(".opencode/agents/frontier-synthesizer.md")
  assert.match(source, /"\*": deny/)
  assert.doesNotMatch(source, /\b(edit|bash|task):\s*(allow|ask)/)
})

test("local-first routing is pinned to Ollama and forbids direct cloud use", async () => {
  const source = await read(".opencode/agents/local-router.md")
  assert.match(source, /model: ollama\/qwen3\.5:9b/)
  assert.match(source, /Never use cloud services directly/)
})
