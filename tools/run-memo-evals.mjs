import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const root = resolve(process.cwd())
const casesDirectory = join(root, "evals", "cases")
const outputDirectory = join(root, ".memo", "evals")
const required = ["id", "category", "prompt", "expected"]
const files = (await readdir(casesDirectory)).filter((file) => file.endsWith(".json"))
const results = []

for (const file of files) {
  const testCase = JSON.parse(await readFile(join(casesDirectory, file), "utf8"))
  const missing = required.filter((key) => !(key in testCase))
  const valid = !missing.length && Array.isArray(testCase.expected)
  results.push({ file, id: testCase.id ?? null, passed: valid, missing })
}

const summary = { schema_version: 1, ran_at: new Date().toISOString(), total: results.length, passed: results.filter((result) => result.passed).length, failed: results.filter((result) => !result.passed).length, results }
await mkdir(outputDirectory, { recursive: true })
await writeFile(join(outputDirectory, `foundation-${Date.now()}.json`), `${JSON.stringify(summary, null, 2)}\n`, "utf8")
console.log(JSON.stringify(summary, null, 2))
process.exitCode = summary.failed ? 1 : 0
