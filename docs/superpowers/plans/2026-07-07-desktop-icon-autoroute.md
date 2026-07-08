# TeamClaude Desktop — Double-Click Icon + Zero-Command Routing

> Executed by subagents. Base commit: 36ebc77 (packaging plumbing already in: electron-builder.yml, resolveProxyEntry prefers bundled proxy, Supervisor runs it via Electron's Node when packaged, and an `applyAutoRoute(enabled, url)` helper exists in ipc.ts).

**Goal:** The user never runs a command. (1) A one-click "Route my Claude here" toggle persists `ANTHROPIC_BASE_URL` so every new terminal's `claude` uses the app's proxy automatically. (2) A packaged `.exe`/installer with an icon, so `npm run dev` is gone.

## Global constraints
- Everything under `desktop/`. Do NOT modify the proxy `src/`.
- Consume the existing `applyAutoRoute` helper and `deps.proxyInfo` (both already in ipc.ts). Do NOT change the self-contained bootstrap or supervisor logic.
- TS strict; `npm run typecheck`, `npm run build`, `npm test` stay green.

---

### Task A: Auto-route wiring (one-click, applies on launch)

**Files:** `desktop/src/main/ipc.ts`, `desktop/src/preload/index.ts`, `desktop/src/main/index.ts`, `desktop/src/renderer/src/views/Dashboard.tsx`

- [ ] **ipc.ts** — add two handlers right after the existing `ipcMain.handle('tc:proxy:getInfo', …)` line:
```ts
  ipcMain.handle('tc:proxy:getAutoRoute', () => {
    const s = { ...DEFAULT_SETTINGS, ...store.get('settings', DEFAULT_SETTINGS) }
    return { enabled: !!s.autoRoute, url: deps.proxyInfo.url }
  })
  ipcMain.handle('tc:proxy:setAutoRoute', async (_e, enabled: boolean) => {
    await applyAutoRoute(enabled, deps.proxyInfo.url)
    const s = { ...DEFAULT_SETTINGS, ...store.get('settings', DEFAULT_SETTINGS), autoRoute: enabled }
    store.set('settings', s)
    return { ok: true, enabled }
  })
```

- [ ] **preload/index.ts** — in the `proxy` namespace, after `getInfo`, add:
```ts
    getAutoRoute: () => ipcRenderer.invoke('tc:proxy:getAutoRoute'),
    setAutoRoute: (enabled: boolean) => ipcRenderer.invoke('tc:proxy:setAutoRoute', enabled),
```

- [ ] **index.ts** — import the helper and apply on launch. Add `applyAutoRoute` to the existing `./ipc` import. After the `registerIpc({ … })` call, add:
```ts
  // If the user turned on auto-route, re-assert it on launch (the port is
  // stable, but this keeps the env var correct if it ever changed).
  if (settings.autoRoute) void applyAutoRoute(true, proxyInfo.url)
```

- [ ] **Dashboard.tsx** — in `ConnectCard`, add an auto-route toggle above the manual command. Import `Switch` from `@renderer/components/ui/switch` and use local state:
```tsx
  const [auto, setAuto] = useState(false)
  useEffect(() => { void window.tc.proxy.getAutoRoute?.().then((r: { enabled: boolean }) => setAuto(r.enabled)).catch(() => {}) }, [])
  const toggleAuto = async (v: boolean): Promise<void> => { setAuto(v); await window.tc.proxy.setAutoRoute(v) }
```
Render, above the manual `Row text={cmd}`:
```tsx
        <label className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-2">
          <span className="min-w-0 text-xs">
            <span className="font-medium">Route my Claude through this</span>
            <span className="block text-[11px] text-muted-foreground">Sets ANTHROPIC_BASE_URL for new terminals — then just run <span className="font-mono">claude</span>.</span>
          </span>
          <Switch checked={auto} onCheckedChange={v => void toggleAuto(v)} />
        </label>
        <p className="text-[11px] text-muted-foreground">{auto ? 'On — open a NEW terminal and run claude; it routes here automatically.' : 'Or route one session manually:'}</p>
```
Keep the manual `Row text={cmd}` as the fallback shown when `!auto` (wrap it in `{!auto && (…)}`).

- [ ] Verify: `npm run typecheck` clean, `npm run build` exit 0, `npm test` green. Commit `feat(desktop): one-click auto-route (persist ANTHROPIC_BASE_URL) so new terminals route automatically`.

---

### Task B: Build the packaged app (installer + portable)

**Files:** none (runs the build). Depends on Task A committed.

- [ ] Confirm the icon exists: `desktop/build/icon.ico` (already present).
- [ ] Run the Windows build from `desktop/`:
```
npm run build:win
```
- [ ] Report what electron-builder produced under `desktop/dist/` (expect `TeamClaude-1.0.0-setup.exe` and `TeamClaude-1.0.0-portable.exe`). If the build fails, capture the exact error and STOP (report it) — do not guess-fix packaging config blindly.
- [ ] Sanity-check (static, since the packaged GUI can't be driven headlessly): confirm `desktop/dist/win-unpacked/resources/app-proxy/index.js` exists (the bundled proxy) and `desktop/dist/win-unpacked/resources/package.json` exists (so the proxy's `../package.json` resolves). Report both.
- [ ] Do NOT commit `dist/` (it's build output; ensure it's gitignored — add `dist/` to `desktop/.gitignore` if not already). Commit only a `.gitignore` change if needed: `chore(desktop): ignore dist build output`.
- [ ] Report the absolute path of the installer for the user to run, and note that live launch verification (double-click → tray icon → proxy runs) is the user's step.
