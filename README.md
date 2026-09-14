# Memo

Memo is a local workspace with deterministic risk and lifecycle controls. It can
be browsed without OpenCode; execution requires a separately running local
OpenCode server.

## Start Memo Without OpenCode

```powershell
npm run app
```

Open `http://127.0.0.1:4173`. Browsing projects, chats, local transcripts, and
project-scoped memory does not instantiate or contact OpenCode. If execution is
started while OpenCode is unavailable, Memo creates the run then records it as
failed; it exposes a structured unavailable state and does not run a fallback
model.

## Connect Local OpenCode

In one PowerShell window, start the project-pinned server on localhost:

```powershell
.\Start-Memo.ps1 -Project . serve --hostname 127.0.0.1 --port 4096
```

In the window that runs Memo, point it at that local server before starting the
app:

```powershell
$env:MEMO_OPENCODE_URL = "http://127.0.0.1:4096"
$env:MEMO_OPENCODE_USERNAME = $env:OPENCODE_SERVER_USERNAME
$env:MEMO_OPENCODE_PASSWORD = $env:OPENCODE_SERVER_PASSWORD
npm run app
```

Memo accepts only local HTTP OpenCode URLs. The optional Memo-specific username
and password must be configured together, remain in process memory, and are not
returned by Memo APIs. The OpenCode client integration assigns upstream
user-message identifiers with the `msg-` prefix.

## Verify

```powershell
npm test
npm run eval:memo
npm run test:browser
```

`npm run eval:memo` validates deterministic fixture metadata only; it does not
call or claim a model run. `npm run test:browser` starts a temporary local Memo
server with a fake adapter, checks desktop/tablet/mobile behavior, and writes its
report and screenshots under `.memo/browser-evidence/`. All `.memo/` state and
evidence is generated locally and is not versioned.

See `MEMO_PHASE2.md` for lifecycle, memory, audit, and release boundaries.
