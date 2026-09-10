---
description: Run budget mode with local Qwen; final output is not guaranteed Sol-authored.
agent: local-router
subtask: false
---

Use local-first Memo routing. Run deterministic risk preflight first. If high
risk, do not execute locally. Otherwise run the smallest relevant checks and
report routing, verification, and remaining risk.

Request: $ARGUMENTS
