import assert from "node:assert/strict"
import test from "node:test"
import { assessRisk } from "../.opencode/lib/memo-risk.mjs"

const highRiskCases = [
  ["Delete customer data from the production database.", "destructive-data"],
  ["Implement OAuth login with password recovery.", "authentication"],
  ["Add Stripe checkout and refund handling.", "payments"],
  ["Backfill the database schema migration.", "database-migration"],
  ["Publish a customer-facing webhook endpoint.", "public-api"],
  ["Fix a race condition in distributed transactions.", "concurrency"],
  ["Patch the SQL injection vulnerability in access control.", "security"],
]

for (const [request, category] of highRiskCases) {
  test(`routes ${category} work to independent supervision`, () => {
    const result = assessRisk(request)
    assert.equal(result.risk, "high")
    assert.equal(result.required_route, "codex-supervisor")
    assert.ok(result.matches.includes(category))
  })
}

test("accumulates independent high-risk categories", () => {
  const result = assessRisk("Add payment authentication to a public API endpoint.")
  assert.deepEqual(result.matches, ["authentication", "payments", "public-api"])
  assert.equal(result.required_route, "codex-supervisor")
})

test("keeps ordinary documentation work on the standard route", () => {
  const result = assessRisk("Clarify the local installation instructions and correct a typo.")
  assert.equal(result.risk, "standard")
  assert.equal(result.required_route, "memo-task-analyzer")
  assert.deepEqual(result.matches, [])
})
