import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const root = resolve(process.cwd())
const casesDirectory = join(root, "evals", "cases")
const outputDirectory = join(root, ".memo", "evals")
const requirements = {
  id: (value) => typeof value === "string" && value.trim().length > 0,
  category: (value) => typeof value === "string" && value.trim().length > 0,
  prompt: (value) => typeof value === "string" && value.trim().length > 0,
  expected: (value) => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim().length > 0),
}
const files = (await readdir(casesDirectory)).filter((file) => file.endsWith(".json")).sort()
const results = []

for (const file of files) {
  try {
    const fixture = JSON.parse(await readFile(join(casesDirectory, file), "utf8"))
    const object = fixture && typeof fixture === "object" && !Array.isArray(fixture)
    const missingRequirements = object ? Object.keys(requirements).filter((key) => !(key in fixture)) : Object.keys(requirements)
    const invalidRequirements = object ? Object.entries(requirements).filter(([key, validate]) => key in fixture && !validate(fixture[key])).map(([key]) => key) : []
    const failures = []
    if (!object) failures.push("Fixture must be a JSON object.")
    if (missingRequirements.length) failures.push(`Missing fixture requirements: ${missingRequirements.join(", ")}.`)
    if (invalidRequirements.length) failures.push(`Invalid fixture contract: ${invalidRequirements.join(", ")}.`)
    results.push({ file, fixture_id: object && typeof fixture.id === "string" ? fixture.id : null, passed: failures.length === 0, missing_requirements: missingRequirements, failure_reason: failures.join(" ") || null })
  } catch (error) {
    results.push({ file, fixture_id: null, passed: false, missing_requirements: [], failure_reason: `Invalid JSON: ${error.message}` })
  }
}

const duplicateIDs = new Set(results.filter((result) => result.fixture_id).map((result) => result.fixture_id).filter((id, index, ids) => ids.indexOf(id) !== index))
for (const result of results) {
  if (!duplicateIDs.has(result.fixture_id)) continue
  result.passed = false
  result.failure_reason = `Duplicate fixture ID: ${result.fixture_id}.`
}

const summary = { schema_version: 1, ran_at: new Date().toISOString(), total: results.length, passed: results.filter((result) => result.passed).length, failed: results.filter((result) => !result.passed).length, results }
await mkdir(outputDirectory, { recursive: true })
await writeFile(join(outputDirectory, `foundation-${Date.now()}.json`), `${JSON.stringify(summary, null, 2)}\n`, "utf8")
console.log(JSON.stringify(summary, null, 2))
process.exitCode = summary.failed ? 1 : 0
