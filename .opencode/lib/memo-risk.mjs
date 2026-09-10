export const rules = [
  ["destructive-data", /\b(delete|drop|truncate|purge|wipe|destroy)\b.{0,80}\b(database|table|production|customer|user|record|data)\b/i],
  ["authentication", /\b(auth(?:entication|orization)?|oauth|login|password|credential|session|token|secret)\b/i],
  ["payments", /\b(payment|billing|charge|refund|checkout|stripe|razorpay|invoice)\b/i],
  ["database-migration", /\b(database|schema)\b.{0,80}\b(migration|migrate|alter|backfill)\b|\b(migration|migrate|alter|backfill)\b.{0,80}\b(database|schema)\b/i],
  ["public-api", /\b(public|external|customer[- ]facing)\b.{0,80}\b(api|endpoint|contract|webhook)\b|\b(api|endpoint|contract|webhook)\b.{0,80}\b(public|external|customer[- ]facing)\b/i],
  ["concurrency", /\b(concurrency|concurrent|race condition|locking|deadlock|distributed transaction)\b/i],
  ["security", /\b(security|vulnerability|exploit|permission|access control|encryption|cryptograph|injection)\b/i],
]

export const assessRisk = (request) => {
  const matches = rules.filter(([, pattern]) => pattern.test(request)).map(([category]) => category)
  return {
    risk: matches.length ? "high" : "standard",
    matches,
    required_route: matches.length ? "codex-supervisor" : "memo-task-analyzer",
    note: matches.length
      ? "This preflight requires Sol supervision and user approval before execution."
      : "This preflight found no mandatory high-risk category; normal Memo analysis may continue.",
  }
}
