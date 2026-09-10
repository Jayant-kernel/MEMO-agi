# Memo Phase 2: Measurable Foundation

## Scope

Phase 2 introduces durable local state and a minimal evaluation harness. It does
not automatically change model routing, permissions, prompts, or project files.

## Local State

For each project launched through `Start-Memo.ps1`, Memo stores local state under
that project's `.memo/` directory:

- `tasks/<task-id>.json`: request, risk, acceptance criteria, verification plan,
  and resumable checkpoints.
- `runs/<run-id>.json`: run summary, counts, token estimates, and final status.
- `runs/<run-id>.events.jsonl`: append-only compact trace events.
- `evals/*.json`: evaluation-harness results.

The ledger records supplied estimates only. It does not claim provider-billed
token counts or costs that OpenCode does not expose.

## Workflow

For substantial work, create a manifest after risk preflight and before work.
Start a run, record material routing, delegation, verification, failures, and
checkpoints, then finalize it with the actual outcome. A manifest checkpoint is
not proof that a criterion passed; record deterministic evidence separately.

## Evaluation

`npm test` validates the state module. `npm run eval:memo` validates fixture
shape and records its result locally. This is the initial harness, not a quality
claim about any model. Expand it with real failures and held-out cases before
using it to promote routing or prompt changes.

## Limitations

This Hello root is not a Git repository. The existing commit-and-tag promotion
requirement therefore cannot be enforced until a repository is initialized with
explicit user approval.
