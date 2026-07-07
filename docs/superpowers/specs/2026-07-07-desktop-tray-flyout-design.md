# TeamClaude Desktop — Tray + Edge Flyout UI

**Date:** 2026-07-07
**Status:** Approved design, pre-implementation

## Purpose

A Windows desktop wrapper for teamclaude that lives in the system tray and
expands into a flyout panel from the right screen edge. It fully replaces the
terminal TUI (status, accounts, routing, activity, OAuth account adding) and
adds a project launcher that opens a chosen folder in Trae (VS Code fork) with
an integrated terminal pointed at the proxy.

## Decisions made

| Decision | Choice |
| --- | --- |
| Process role | Wrapper owns the teamclaude process (spawn, supervise, restart) |
| Scope | Full TUI replacement + project launcher |
| Shell | Electron (all-JS, same runtime as the proxy) |
| Frontend | React + Vite + Tailwind + shadcn/ui (shadcn MCP available) |
| Widget mode | Tray icon + slide-out edge flyout (Windows 11 flyout style); no reserved screen space; pinnable |
| Integration | Child process + localhost HTTP/SSE only — no in-process imports |

## Architecture

```
Electron app (new: desktop/ folder)
  Main process
    - Process supervisor: spawns `node src/index.js --headless`, restart w/ backoff
    - Tray icon + flyout window manager (frameless, always-on-top, auto-hide)
    - Trae/terminal launcher (child_process)
  Renderer (React + shadcn)
    - Talks to the proxy exclusively via localhost HTTP + SSE
        |
teamclaude (this repo, small additions)
  existing: GET /teamclaude/status, POST /teamclaude/reload, account pin
  new:      SSE events, OAuth-flow API, log tail, --headless flag
```

Hard boundary: the proxy stays fully usable standalone from a terminal; every
UI capability is an HTTP endpoint (curl-scriptable). The UI cannot crash the
proxy and vice versa.

## Component 1: teamclaude additions (this repo)

- `--headless` flag (or confirm non-TTY detection suffices) to run without the TUI.
- `GET /teamclaude/events` — SSE stream: status changes, rotation events,
  request-log entries. Reconnect-safe.
- OAuth add-account API mirroring the TUI flow:
  - `POST /teamclaude/oauth/start` → returns authorize URL (UI opens default browser)
  - completion endpoint(s) matching the existing oauth.js callback flow
- Log tail endpoint returning recent request history for panel open.
- All new endpoints sit behind the existing localhost/proxy-key auth gate.

## Component 2: Electron app (`desktop/`)

### Tray
- Always present. Icon state signals health: normal / quota-limited / proxy down.
- Left-click (or global hotkey, default `Ctrl+Shift+Space`): toggle flyout.
- Right-click menu: pin flyout, start/stop proxy, launch at login, quit.

### Flyout window
- Frameless, always-on-top, ~420px wide, slides from the right edge near the tray.
- Auto-hides on focus loss unless pinned via a header toggle.
- No screen space reserved (not an AppBar).

### Panel views
1. **Dashboard** — active account, per-account quota bars, rotation order,
   proxy uptime, request throughput sparkline.
2. **Accounts** — add via OAuth, enable/disable, pin/unpin, remove, detail view.
3. **Routing** — visual editor for per-model routes (#86), writes back to config
   and triggers `/teamclaude/reload`.
4. **Activity** — live request log via SSE, filterable.
5. **Launcher** — saved project paths; "Open in Trae" opens the folder in Trae
   and best-effort auto-opens an integrated terminal (auto-run workspace task)
   with `ANTHROPIC_BASE_URL` pointed at the proxy.
6. **Settings** — proxy port/config path, hotkey, launch-at-login, theme.

### Design quality
Dark-mode-first tray-utility aesthetic. shadcn/ui components via the user's
MCP connection; apply frontend-design/impeccable skills during implementation
to avoid default-shadcn genericism.

## Process supervision

- Single-instance lock (Electron `requestSingleInstanceLock`).
- On start: probe configured port. If a teamclaude instance responds, attach;
  otherwise spawn headless child.
- Crash → restart with exponential backoff + tray notification.
- Clean quit stops the child. Optional launch-at-login.

## Error handling

- Proxy unreachable → flyout shows explicit "proxy down" state with a restart
  button; all fetch failures degrade gracefully (no renderer crashes).
- SSE client reconnects automatically with backoff.

## Testing

- New teamclaude endpoints: node:test coverage alongside the existing suite.
- Renderer data layer (status parsing, SSE client): Vitest unit tests.
- Tray/window mechanics: manual verification on Windows 11.

## Build order

1. teamclaude endpoint additions + headless flag (small, tested)
2. Electron shell: tray + flyout window mechanics + process supervisor
3. Dashboard + Accounts views
4. Activity (SSE) + Routing editor
5. Launcher + Settings + polish pass

## Out of scope

- macOS/Linux support (Windows-first; nothing precludes porting later)
- True AppBar docking (reserved screen space)
- Auto-update of the desktop app
