---
description: Use GPT-5.6 Sol to review UI screenshots against an explicit design brief.
agent: ui-quality-critic
model: openai/gpt-5.6-sol
subtask: true
---

Review the supplied design brief, screenshots, deterministic checks, and issue
ledger. Return only prioritized actionable issues or explicit approval with
residual uncertainty.

Request: $ARGUMENTS
