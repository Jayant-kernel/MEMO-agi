# Memo

Memo is a local, evidence-first workspace for project-scoped AI work. Its first
application slice stores projects, chats, and user messages locally; it does not
send messages to a model or execute commands.

## Run

```powershell
npm run app
```

Open `http://127.0.0.1:4173`. Workspace data is written to `.memo/workspace.json`
and is intentionally excluded from Git.

## Verify

```powershell
npm test
npm run eval:memo
```

See `MEMO_PHASE2.md` for implemented state boundaries and deferred capabilities.
