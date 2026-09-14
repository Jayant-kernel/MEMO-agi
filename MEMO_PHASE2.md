# Memo Phase 2: Deterministic Boundaries

## Execution Lifecycle

Memo classifies each request locally. High-risk categories require explicit
review of the exact request before execution: destructive data, authentication,
payments, database migrations, public APIs, concurrency, and security. Approval
is content-hash and nonce bound, so stale or altered approval is rejected.

Only upstream permissions owned by the active run and session are accepted.
Memo supports `once` and `reject`; remembered permissions, including remembered
rejection, are unsupported. Stop, retry, and resume are distinct operations.
Retry retains the original local user message, while sequential requests reuse a
saved session. Resume imports only new upstream messages. On restart, active
execution is reconciled to a failed run that can be retried; pending high-risk
approval remains pending.

## Local State And Memory

Memo writes generated workspace state, ledgers, evaluation results, and browser
evidence under `.memo/`; the directory is ignored by Git. Its local governed
memory is explicitly project-scoped, disabled by default, isolated between
projects, and never injected into OpenCode prompts. Memory records reject
credential-like content and sources.

## Evaluation And Evidence

`npm run eval:memo` checks the explicit metadata contract of JSON fixtures and
writes a result under `.memo/evals/`. Fixtures are not model executions or model
quality claims. `npm run test:browser` uses a fake adapter and emits a report and
screenshots under `.memo/browser-evidence/` after desktop, tablet, and mobile
checks.

## Audit And Release Decisions

The verified Phase 1 audit recorded six production findings, including three
high-severity transitive findings. No audit remediation was forced because the
offered fix downgraded Magic Context; dependency remediation requires Sol review.

These release decisions remain unresolved: the normal route is cloud-configured,
authenticated OpenCode is unsupported, and dependency remediation requires Sol
review. This document records current boundaries, not authorization to alter
routing, dependencies, permissions, prompts, providers, or configuration.
