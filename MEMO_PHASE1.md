# Memo Phase 1

## Boundary

Memo is active only when `Start-Memo.ps1` launches OpenCode for a project under
this `Hello` folder. Directly opening a folder in OpenCode Desktop does not set
the required environment variables and therefore does not activate Memo.

This launcher is necessary because project configuration discovery stops at a
nested Git repository. A parent `Hello/opencode.jsonc` is not reliable for
every child project.

## Deterministic Risk Preflight

`memo_risk_assess` matches task text against a conservative policy before the
local analyzer is used. A high-risk result requires Sol supervision and cannot
be routed to a local execution worker by the Memo workflow.

The preflight is not a security boundary. Approval prompts, least-privilege
permissions, deterministic verification, and user review remain required.

## Deferred Work

The research radar, scheduler, routing gate, richer evaluation suite, and UI
automation are separate phases. Phase 2 now provides a per-run local trace/cost
ledger and an initial evaluation harness. Before automated research intake,
Memo still needs source-isolation enforcement and research-specific evaluation.
