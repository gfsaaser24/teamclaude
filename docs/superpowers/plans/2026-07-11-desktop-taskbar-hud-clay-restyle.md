# Plan: Desktop taskbar window, HUD resilience, clay premium restyle

Spec: `docs/superpowers/specs/2026-07-11-desktop-taskbar-hud-clay-restyle-design.md` (approved 2026-07-11).

## Global Constraints

- All changes live under `desktop/`. Never touch the proxy (`src/` at repo root), `desktop/dist/`, or `node_modules`.
- Branch: `feature/desktop-app`, commit directly (no worktree). One commit per task, conventional prefix (`feat(desktop):`, `fix(desktop):`, `style(desktop):`), ending with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_0195FPNfi1DmmXGhtEKFNAKm`
- Per-task verification: `npm run typecheck` and `npm test` (vitest) from `desktop/` must pass. Do NOT launch the Electron app (no GUI available to subagents); runtime verification is the controller's job.
- Keep the shadcn CSS-variable contract (`--background`, `--foreground`, `--primary`, `--muted-foreground`, `--border`, `--ring`, `--radius`, …) — components restyle through tokens, not per-component color rewrites.
- Clay `#d97757` is `--primary` and means IDENTITY (active account, active tab, CTAs, focus). It never signals warning. Quota-meter utilization colors in `RadialMeter.tsx` / `QuotaBar.tsx` (teal OK / amber ≥80% / red ≥98%) are semantic and must NOT change.
- Allowed new dependencies, exactly: `motion`, `@fontsource/jetbrains-mono`, and copied cult-ui component source files (via `npx shadcn@latest add @cult-ui/<name>` — registry configured in `desktop/components.json`). No other new deps; no upgrades of existing deps.
- No layout/IA changes: same tabs, same views, same window structure. Restyle only, plus the minimize feature and crash hardening from Tasks 1–2.
- UI text style: labels/eyebrows are mono uppercase; view titles/wordmark serif (Georgia stack); numbers tabular mono.

## Task 1: Taskbar presence + minimize button

Goal: the flyout behaves like a real app window — taskbar button whenever visible, minimize to taskbar, restore from taskbar/tray/hotkey. (Spec §A.)

Files:
- `desktop/src/main/flyout.ts`
  - `createFlyout()`: change `skipTaskbar: true` → `skipTaskbar: false`.
  - Blur handler: `flyout.on('blur', () => { if (!pinned) flyout?.hide() })` → hide only when `!pinned && !flyout.isMinimized()`. (Minimizing fires blur on Windows; without the guard the window hides itself and vanishes from the taskbar.)
  - `toggleFlyout()`: if `flyout.isMinimized()`, call `flyout.restore()` then `flyout.focus()` and return (instead of hiding). Visible-and-not-minimized still hides; hidden still shows+focuses (keep the existing `userMoved` re-anchor logic).
  - New export `minimizeFlyout(): void` → `flyout?.minimize()`.
- `desktop/src/main/ipc.ts`: new handler `ipcMain.handle('tc:window:minimize', () => deps.minimizeFlyout())`; add `minimizeFlyout: () => void` to `IpcDeps`.
- `desktop/src/main/index.ts`: pass `minimizeFlyout` into `registerIpc` (import from `./flyout`).
- `desktop/src/preload/index.ts` + `index.d.ts`: add `window.tc.window.minimize(): Promise<void>` next to the existing `hide`/`setPinned`/`setCompact`.
- `desktop/src/renderer/src/App.tsx`: in the header window-controls cluster, add a ghost icon button with lucide `Minus`, `aria-label="Minimize to taskbar"`, placed before the compact-mode button, calling `void window.tc.window.minimize()`.

Verification: `npm run typecheck`, `npm test`. Commit `feat(desktop): minimize to taskbar — flyout becomes a real app window`.

## Task 2: Crash instrumentation, dock auto-recreate, ErrorBoundary

Goal: a dying HUD is logged, auto-healed, and component errors render a fallback instead of a blank window. (Spec §B.1–B.3.)

Files:
- `desktop/src/main/index.ts`: `app.on('child-process-gone', (_e, details) => logLine('app', ...))` logging `type`, `reason`, `exitCode`, `name` — this catches GPU-process deaths.
- `desktop/src/main/flyout.ts`: after window creation, `flyout.webContents.on('render-process-gone', (_e, d) => logLine('flyout', `render-process-gone reason=${d.reason} exitCode=${d.exitCode}`))`.
- `desktop/src/main/dock.ts`:
  - Same `render-process-gone` logging (`logLine('dock', …)`).
  - Auto-recreate: on renderer death, destroy the dock window and recreate it (preserving stored opacity, which already re-applies in `createDock`). Backoff policy in a NEW pure module `desktop/src/main/crash-backoff.ts`: `export function shouldRecreate(recentMs: number[], nowMs: number): boolean` — true while there are fewer than 3 recreations in the trailing 60s window. Dock keeps its own `number[]` of recreate timestamps. When the budget is exhausted: log `dock renderer crash loop — giving up` and stop recreating.
  - Note: recreated dock returns collapsed; acceptable, document in code comment.
- `desktop/src/main/crash-backoff.test.ts`: vitest unit tests for `shouldRecreate` (allows first 3 within a minute, blocks the 4th, allows again after the window slides).
- `desktop/src/main/ipc.ts`: fire-and-forget renderer log channel — `ipcMain.on('tc:log', (_e, source: unknown, line: unknown) => { if (typeof source === 'string' && typeof line === 'string') logLine(`renderer:${source.slice(0, 32)}`, line.slice(0, 2000)) })`.
- `desktop/src/preload/index.ts` + `index.d.ts`: `window.tc.log(source: string, line: string): void` using `ipcRenderer.send('tc:log', …)`.
- NEW `desktop/src/renderer/src/components/ErrorBoundary.tsx`: React class component with `name` prop; `componentDidCatch` reports `error.message` + component stack via `window.tc.log('error-boundary', …)` (guard `window.tc?.log` existence); fallback UI = compact centered card ("Something broke", the error message in mono small text, a Reload button calling `window.location.reload()`). Must render sanely inside BOTH the 420px flyout and the 56px transparent dock (keep it minimal: padding, no fixed width).
- `desktop/src/renderer/src/main.tsx`: wrap `<App />` in `<ErrorBoundary name="app">` and `<Dock />` in `<ErrorBoundary name="dock">`.

Verification: `npm run typecheck`, `npm test` (new backoff tests green). Commit `fix(desktop): crash logging, dock auto-recreate with backoff, renderer error boundaries`.

## Task 3: Warm ink + clay token system, typography, motion dep

Goal: rebuild the design tokens so the whole app inherits the premium warm-dark + clay look. (Spec §C.)

Steps:
1. In `desktop/`: `npm install motion @fontsource/jetbrains-mono`.
2. Read `desktop/src/renderer/src/assets/main.css` and `base.css` first — the app is dark-only; keep it dark-only.
3. Rewrite the token layer in `main.css` (Tailwind v4 — adjust via `@theme` and the shadcn `:root` variable block), targeting these values (express as oklch equivalents if the file already uses oklch — cite the hex in a comment):
   - `--background` `#141413` (warm ink; NOT zinc), `--card` `#1f1e1c`, `--popover` `#1f1e1c`, `--secondary` `#262522` (hover ladder one step lighter per state where used).
   - `--foreground` `#faf9f5` (cream), `--muted-foreground` `#b0aea5` (warm cloud), tertiary text where needed `#87867f`.
   - `--primary` `#d97757` (clay), `--primary-foreground` `#141413`, hover intent = deep `#c6613f` (expose as `--primary-hover` or use in button styles), `--ring` clay, `--accent` = clay at ~12% alpha, `--accent-foreground` cream.
   - `--border` / `--input` = warm hairline, cream at ~10% alpha. `--destructive` keeps a red.
   - `--radius: 0.5rem` (8px controls). Cards go 16px: update `components/ui/card.tsx` root to `rounded-2xl`.
   - Fonts: import JetBrains Mono weights 400/500/700 from `@fontsource/jetbrains-mono`; define `--font-serif: Georgia, 'Times New Roman', serif` and `--font-mono: 'JetBrains Mono', Consolas, monospace` in `@theme` so Tailwind's `font-serif`/`font-mono` utilities use them. Body stays system sans.
4. Sweep for hardcoded cold grays in shared chrome (`bg-neutral-950`, `border-white/12`, etc. in `Dock.tsx` stay for now — Task 6 owns Dock) — this task only guarantees the token layer + `card.tsx` radius; do not restyle views here.
5. Sanity: `QuotaBar.tsx` / `RadialMeter.tsx` explicit meter colors remain untouched and legible on `#141413`.

Verification: `npm run typecheck`, `npm test`, plus `npx electron-vite build` compiles CSS cleanly. Commit `style(desktop): warm ink + clay design tokens, serif/mono type system, motion dep`.

## Task 4: Chrome, tabs, and Dashboard restyle with motion

Goal: the app's first screen reads premium — serif wordmark, mono status eyebrow, sliding clay tab indicator, animated dashboard. (Spec §D chrome/tabs/Dashboard.)

Files: `desktop/src/renderer/src/App.tsx`, `components/ui/tabs.tsx` (restyle only), `views/Dashboard.tsx`, optionally new small components under `components/`.

Requirements:
- Header: wordmark "TeamClaude" in `font-serif` (weight 400, tracking-tight); proxy state becomes a mono uppercase eyebrow chip (e.g. `PROXY · RUNNING`) replacing the current Badge look — colors: emerald tint for running/attached, amber starting, red crashed/stopped; window-control buttons unified (ghost, `size-4` icons, warm hover).
- Tab strip: triggers in mono uppercase text-[11px] tracking-[0.08em]; active tab gets a clay underline that SLIDES between triggers via `motion` `layoutId` (one motion span per active trigger). Keep radix Tabs semantics/API.
- Tab content: wrap each `TabsContent`'s child in a `motion.div` fade/slide-in (~180ms, ease-out, y offset 4px). No exit animations (radix unmounts).
- Dashboard hero: the active-account block becomes the hero card — account name in serif at display size, mono eyebrow label (e.g. `ACTIVE ACCOUNT`), meters prominent; try `npx shadcn@latest add @cult-ui/texture-card` and use TextureCard for the hero if it fits the 420px panel (if the registry fetch fails or the component clashes, build a refined Card locally and note it in the report).
- Animated numbers: meter percentage read-outs tick up/down via a small `AnimatedNumber` component (motion `animate()` on a spring, ~0.6s) — apply in `RadialMeter.tsx`'s center read-out WITHOUT touching its color logic.
- Respect `compact` mode: hero card must still fit the 300×360 compact HUD window.

Verification: `npm run typecheck`, `npm test`. Commit `style(desktop): serif/mono chrome, sliding clay tab indicator, animated dashboard hero`.

## Task 5: Views restyle — Accounts, Routing, Activity, Launcher, Settings

Goal: every remaining view speaks the same card language. (Spec §D views.) No logic changes — className/markup-level restyle only; all handlers, IPC calls, and state stay byte-identical.

Files: `desktop/src/renderer/src/views/{Accounts,Routing,Activity,Launcher,Settings}.tsx`, `desktop/src/renderer/src/components/QuotaBar.tsx` (chrome only, not colors).

Requirements per view:
- Section/card titles: mono uppercase eyebrows (text-[10px] tracking-[0.1em] text-muted-foreground) above content; card internals on the 8px spacing scale.
- Accounts: active account gets clay ring + clay index chip (`bg-primary`); disabled accounts drop to 50% with a mono `DISABLED` tag; hover = one surface step lighter.
- Activity: event rows in mono text-[11px], timestamps tertiary `#87867f`-toned (`text-muted-foreground/70` is fine), request events get a clay left hairline on hover; keep list virtualization/slicing exactly as-is.
- Routing: route cards with hairline borders; model/account chips mono.
- Launcher: project rows with serif project names, mono paths, clay "open" affordance on hover.
- Settings: group cards consistent with the rest; the dock-opacity slider thumb + switch accents inherit clay via tokens (verify, adjust classes only if a hardcoded color fights the token).
- Empty states everywhere: short serif sentence + mono hint line.

Verification: `npm run typecheck`, `npm test`. Commit `style(desktop): unified card language across all views`.

## Task 6: Dock + Onboarding restyle

Goal: the HUD strip and first-run flow match the new identity. (Spec §D dock/onboarding.)

Files: `desktop/src/renderer/src/Dock.tsx`, `desktop/src/renderer/src/onboarding/Onboarding.tsx` + `onboarding/steps/*.tsx`.

Requirements:
- Dock: replace cold `bg-neutral-950` / `border-white/12` with warm ink (`#141413`-based, translucent OK) and warm hairlines; active account ring/chip = clay (mostly free via `--primary`); LIVE bar stays emerald (semantic); left accent hairline becomes clay-tinted; expanded panel header "Dock" becomes mono uppercase eyebrow. Springy expand/collapse: animate the inner panel content with `motion` (spring, subtle) — the OS window resize itself stays instant.
- Onboarding: ink-band treatment — full-bleed `#141413` background, step headings in serif display (text-2xl+, weight 400), mono `STEP N / 4` eyebrow, primary CTA = clay filled button (`bg-primary text-primary-foreground`, hover deep `#c6613f`), secondary = hairline outline. Keep all step logic/flow identical.

Verification: `npm run typecheck`, `npm test`. Commit `style(desktop): warm ink dock + editorial onboarding`.

## Task 7: Dock crash root-cause (controller-led, instrumented repro)

Goal: find and fix the actual tab-nav crash trigger using Task 2's instrumentation. (Spec §B.4.)

Procedure (controller runs this, not a detached subagent — needs the GUI):
1. Build + run the dev app with the dock enabled; navigate flyout tabs per the user's repro until the dock dies.
2. Read `%APPDATA%\TeamClaude\logs\desktop.log`: `render-process-gone` reason (`crashed` / `oom` / `killed`) and any `child-process-gone` GPU lines decide the fix:
   - GPU-process death or `killed` → transparency/compositing path: candidate fixes are removing `backgroundMaterial: 'acrylic'` from the flyout, or recreating the dock without `transparent: true` (opaque + rounded CSS), or as last resort `app.disableHardwareAcceleration()`.
   - `oom` → hunt the leak (events array, motion loops).
   - JS error via ErrorBoundary log → fix the component bug directly.
3. Whatever the fix, keep the Task 2 auto-recreate as defense in depth.
4. Commit `fix(desktop): <evidence-based description of dock crash fix>`.

Verification: repro no longer kills the dock across ≥10 tab-nav cycles; auto-recreate log stays silent.
