# TeamClaude Desktop v1.1 — Taskbar Window, HUD Resilience, Clay Premium Restyle

Date: 2026-07-11
Status: Approved (user, 2026-07-11)

## Goals

1. The main panel can minimize to the Windows taskbar like a real application.
2. The edge dock (micro-HUD) stops dying silently — it is instrumented, self-healing, and the tab-nav crash trigger is found and fixed from evidence.
3. The whole app (flyout, dock, onboarding) gets a premium "warm ink + clay" restyle derived from the Anthropic design system (`anthropic.design.md`), with `motion` micro-interactions and a small number of cult-ui components.

Non-goals: no light theme, no navigation/IA restructure, no new features beyond minimize, quota-meter color semantics unchanged (teal/amber/red).

## A. Minimize to taskbar (real app window)

- `desktop/src/main/flyout.ts`: create the flyout with `skipTaskbar: false`. Blur handler becomes `if (!pinned && !flyout.isMinimized()) flyout.hide()` — minimizing fires blur on Windows; without the guard the window hides itself out of the taskbar.
- `toggleFlyout()` gains an `isMinimized()` branch: `restore()` + `focus()` instead of hide. Applies to tray click, hotkey, and `second-instance`.
- New IPC `tc:window:minimize` (ipc.ts + preload + `window.tc.window.minimize()` typing).
- `App.tsx` header: a minimize button (Minus icon) in the window-controls cluster.
- Dock unaffected: stays `skipTaskbar: true`, always-on-top.

## B. HUD crash: instrument, auto-heal, root-cause

1. **Crash logging** — `webContents.on('render-process-gone')` on both windows and `app.on('child-process-gone')` (covers GPU process), logging reason/exitCode to `desktop.log` via `logLine`. Today a dock crash leaves zero trace.
2. **Dock auto-recreate** — on the dock renderer dying: destroy + recreate the dock window. Backoff: max 3 recreates per minute, then stop and log loudly.
3. **React ErrorBoundary** wrapping both `<App/>` and `<Dock/>` (`main.tsx`): renders a compact "crashed — reload" card with the error message and a reload button; reports the stack to the main process over a new `tc:log` IPC so it lands in `desktop.log`.
4. **Root-cause hunt** — with instrumentation in place, reproduce the user's repro (dock open, navigate tabs in the flyout, dock strip dies). Prime suspect: Windows GPU/transparent-window path (`transparent: true` dock). Fix follows the logged evidence (GPU kill vs renderer OOM vs JS error), not a guess.

## C. Design system: "warm ink + clay" tokens

Token-first rewrite of `desktop/src/renderer/src/assets/main.css` (Tailwind v4 `@theme` / CSS variables), keeping the shadcn variable contract (`--background`, `--primary`, …) so existing components restyle from the root:

- **Surfaces**: warm ink ladder — base `#141413`, raised `#1f1e1c`, hover one step lighter; hairlines = warm white at low alpha. No cold zinc anywhere.
- **Text**: cream `#faf9f5` primary; warm cloud `#b0aea5` secondary; `#87867f` tertiary.
- **Accent**: clay `#d97757` as `--primary` (hover deep `#c6613f`), ink foreground on clay fills. Clay = identity: active account, active tab, CTAs, focus rings. Clay never signals warning.
- **Meters**: utilization colors unchanged (teal OK / amber ≥80% / red ≥98%).
- **Radii**: 8px controls, 16px cards.
- **Type**: serif display (Georgia stack) for wordmark + view titles; mono uppercase eyebrows (JetBrains Mono, Consolas fallback) for labels/statuses/numbers; system sans body.
- **Motion**: add `motion` package. Tab content fade/slide ~180ms, `layoutId` clay underline sliding between tabs, animated number tickers on meters, springy dock expand/collapse, press-scale on primary buttons. Micro only — no scroll theatrics.
- **cult-ui**: 2–4 cherry-picked components via the shadcn MCP + `@cult-ui` registry (candidates: texture-card for dashboard hero, texture-button for CTAs, animated number for meters). Chosen at implementation time; budgeted, not a sweep.

## D. Surface-by-surface restyle (structure/logic unchanged)

Header (serif wordmark, mono status eyebrow, refined window controls incl. new minimize), tab strip (mono uppercase + sliding clay indicator), Dashboard hero card, Accounts (clay active ring), Routes/Activity/Projects/Settings unified on the card language, Dock (warm ink glass, clay active-account accent, LIVE bar stays emerald), Onboarding (ink band + serif display + clay CTA).

## Verification

- `npm run typecheck` and `npm test` (vitest) pass in `desktop/`.
- Manual dev pass: taskbar presence, minimize/restore via taskbar + tray + hotkey, blur-hide still works unpinned, pin behavior unchanged.
- Simulated dock crash (`process.crash()` in dock devtools) → auto-recreate observed, crash logged.
- Visual pass: all six tabs, both dock states, onboarding replay.
- Packaged `build:win` smoke test.

## Risks

- Transparent-window fixes on Windows may require trade-offs (e.g., disabling acrylic on the flyout or hardware acceleration for the dock); decided by evidence during B.4.
- cult-ui components must be vetted for bundle weight and 420px-panel fit before adoption.
