---
description: Run Memo's artifact-driven implementation workflow.
agent: frontier-orchestrator
model: openai/gpt-5.6-sol
subtask: false
---

Run Memo's deterministic risk preflight first. If standard risk, create a Memo
execution manifest and run ledger, validate them, and execute only necessary
tracks after user approval. Record material routing, checks, failures, and the
final outcome. For UI work require a design brief, named viewports, deterministic
checks, screenshots, and an issue ledger. Keep worker outputs as compact
artifacts, not conversation. Finish with a frontier-authored response.

Request: $ARGUMENTS
