# Memo UI Quality Loop

For a UI project, create these target-project artifacts:

- `docs/memo/design-brief.md`
- `docs/memo/ui-acceptance.md`
- `artifacts/memo/screenshots/`
- `artifacts/memo/issues.json`

The intended loop is:

```text
Sol design brief
  -> Terra implementation
  -> build, tests, accessibility, responsive checks, screenshots
  -> compact issue ledger
  -> optional Sol visual review
  -> Terra fixes the highest-severity issues
```

This is a bounded review loop, not an autonomous design swarm. Browser tooling
is a future phase and must be added to each target project before this loop can
be mechanically enforced.
