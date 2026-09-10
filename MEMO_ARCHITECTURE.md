# Memo: Cost-Optimized Multi-Agent Orchestrator

## Scope

Memo is started only with `Start-Memo.ps1` for a project under this `Hello`
directory. The launcher sets `OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR`, which
is required for nested Git repositories.

## Routing Graph

```text
User
  -> deterministic risk preflight
  -> Sol coordinator and final response
      -> local Qwen: routine discovery, boilerplate, checks
      -> Luna: bounded drafting and research
      -> Terra: standard implementation and diagnosis
      -> Sol critic: visual/product review after evidence exists
      -> Sol supervisor: high-risk independent review
```

The final normal response is written by Sol. Workers exchange compact artifacts
and deterministic results, not open-ended debate.

## Safety

- Every delegation, edit, and shell command requires approval.
- Workers cannot delegate again.
- The local risk preflight sends mandatory categories to Sol supervision.
- External research is untrusted data under `MEMO_EVIDENCE_POLICY.md`.
- Improvements require an RFC, held-out evaluation, Git commit and tag, material
  Sol review, and user approval.

## Commands

- `/system`: Full evidence-first Memo workflow.
- `/memo-build`: Risk preflight, task manifest, controlled implementation.
- `/local` and `/local-first`: Local budget modes.
- `/luna`, `/terra`, `/research`: Explicit bounded worker routes.
- `/supervise`, `/ui-review`, `/final-sol`: Targeted Sol gates.
