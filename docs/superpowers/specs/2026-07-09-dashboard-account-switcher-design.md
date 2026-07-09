# Dashboard account switcher + opaque dock — design

Date: 2026-07-09. Approved verbally in session.

## Goal

1. Let the user switch (pin) the active account directly from the main panel
   (Dashboard HUD), not just cycle with chevrons or visit the Accounts tab.
2. Make the edge dock ("sidebar") 100% opaque.

## Account switcher

- In `desktop/src/renderer/src/views/Dashboard.tsx`, the static active-account
  name in the HUD becomes a shadcn `Select` (component already exists at
  `components/ui/select.tsx` — no new primitives).
- Trigger: borderless/ghost styling so it reads as the account name plus a
  small chevron; truncates at compact (240px) widths. Custom trigger content
  (not `SelectValue`): always shows `status.currentAccount` — when
  auto-rotating that is the account rotation picked; when pinned it equals the
  pin.
- Items: `Auto-rotate` first (sentinel value `__auto__`), then one item per
  account: name + weekly-used hint (`NN% wk` from `quota.unified7d`) +
  `disabled` / `rate-limited` markers. Selected = pinned account, or
  `Auto-rotate` when `status.manualAccount == null`.
- Action: account → `window.tc.account.pin(name)`; `__auto__` →
  `window.tc.account.pin(null)`; then `refreshStatus()`. Same IPC path the
  chevrons use — zero main-process/proxy changes.
- Chevron prev/next row, pinned badge, and Auto button remain unchanged.
- Fallbacks: no status → existing "Proxy is starting…" card; zero accounts →
  plain text as today.

## Opaque dock

- `Dock.tsx`: collapsed `bg-neutral-950/60 backdrop-blur-xl` → solid
  `bg-neutral-950` (blur removed — dead against an opaque background);
  expanded `bg-neutral-950/70 backdrop-blur-xl` → same.
- Window layer: `DEFAULT_SETTINGS.dockOpacity` 0.92 → 1 (`ipc.ts`), seed
  fallback in `index.ts` 0.92 → 1, and the user's stored
  `%APPDATA%\TeamClaude\config.json` `settings.dockOpacity` set to 1 (edited
  with the app closed so electron-store can't clobber it).
- The Settings transparency slider stays — this changes the value, not the
  control.

## Verification

Typecheck, `build:win`, silent reinstall, relaunch installed app; visually
confirm the dropdown pins accounts (currentAccount changes against the live
proxy) and the dock renders solid.
