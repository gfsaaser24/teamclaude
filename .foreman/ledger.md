# Foreman ledger — Orca TC / TeamClaude integration build
Run started: 2026-07-22 ~18:30 local. LEAD: Claude Fable 5 (session, xhigh). Mode: Full (Agent tool + real shell).
Spec: C:\code\orca-ide\docs\superpowers\specs\2026-07-22-teamclaude-integration-design.md (v2.2; gitignored upstream — absolute path only)
Contract (frozen, foreman-owned): src/shared/teamclaude-types.ts @ orca 18afe148

## Baselines
- teamclaude master @ ac7660c (shim+run--exec committed). Worktrees: wt-tc-server→tc/p0-server, wt-tc-desktop→tc/p0-desktop
- orca-ide main @ 18afe148 (contract committed; spec docs untracked/gitignored). Worktrees: wt-orca-packaging→tc/packaging, wt-orca-core→tc/core, wt-orca-ui→tc/ui
- Deviation from spec §9: upstream merge DEFERRED to post-integration stage (parallel build on 1.4.146-rc.0; seam checklist re-run at merge). User-directed crew: 5× Opus 4.8 (xhigh inherited) in parallel. Nested workers disabled (foreman rail 1).

## Tasks
| ID | Scope | Worktree | Seat | Status |
|----|-------|----------|------|--------|
| T1 | TeamClaude Phase 0 server: endpoints, envelope, certs, exit code, hardening | wt-tc-server | opus | VERIFIED PASS_WITH_NOTES @2762cc0; contract fixes → T8 |
| T8 | Batched fixes: T1 contract mismatches (pin-id, 404 semantics, write order, body cap) + T2-f1/f2 | wt-tc-server + wt-tc-desktop | opus | VERIFIED PASS. TeamClaude Phase 0 COMPLETE (server 297/10, desktop 54/54). Merge held until T4 mismatch list lands |
| T2 | TeamClaude Phase 0 desktop: Routing.tsx/pin migration, hygiene+cleanup | wt-tc-desktop | opus | VERIFIED PASS_WITH_NOTES @56ec7d3 |
| T3 | Orca packaging/identity full namespace + updater gate | wt-orca-packaging | opus | VERIFIED PASS_WITH_NOTES @103cfcb0d. NOTE: worker added ~/.local/bin/pnpm corepack shim (machine-level, benign) |
| T4 | Orca main-process teamclaude module (config/supervisor/client/routing-env/control/ipc) | wt-orca-core | opus | verify FAIL @6ae170e89 (internally clean; A1-A6 wire mismatches + D1/D3-D5) → T10 fix attempt 2 |
| T10 | T4 fix batch: align to real server wire + bridge naming + supervisor defects | wt-orca-core | opus | VERIFIED PASS @ea7f4dbc3 — tc/core ACCEPTED |
| T5 | Orca renderer cockpit (widget/flyout/panel, i18n 5-locale) | wt-orca-ui | opus | verify FAIL @e3455a5d2 (bucket data-loss + 3 matrix gaps) → T9 fix attempt 2 |
| T9 | T5 fix batch (RoutesTab bucket loss, matrix items, labels) | wt-orca-ui | opus | VERIFIED PASS_WITH_NOTES @2cfcbcb47 — tc/ui ACCEPTED |
| T6 | Orca seams + usage feed (pty/daemon/textgen hooks, refresh-plan short-circuit) | wt-orca-core | opus | VERIFIED PASS_WITH_NOTES; F1 (daemon inherited base-URL) fixed by LEAD @240f7b53c w/ tests; F2 accepted-low (CLI self-refresh mitigates); F3 info (no sonnet window field) |
| T7 | Integration merge + verify + upstream merge | main checkouts | LEAD+verifier | COMPLETE (except upstream merge — deferred, next session): teamclaude master @f53c182 v1.2.0 LIVE (proxy restarted, migration healed real config corruption); orca main @022775c7d (3 branches merged clean, T11 punch @b19b8377b, lint-gate fixes @07625f6bf). GATES: 31,913 vitest ZERO new failures; typecheck clean; lint = 1 pre-existing upstream failure only; packaging smoke PASS (OrcaTC.exe, orcatc CLI bin, name orca-tc + productName "Orca TC"); ADOPTION E2E PASS (dev instance held live status+SSE connections to v1.2.0 proxy) |
| T11 | Integration punch list + full gates | orca main | opus | DONE_WITH_CONCERNS @b19b8377b — VERIFIED via baseline-diff (zero new failures) |

## Remaining (next session)
- Upstream merge (stablyai/orca current) + 15-min seam checklist (spec §6).
- Full NSIS installer build + install/uninstall smoke beside official Orca (needs symlink privilege/Dev Mode or CI for winCodeSign; layout smoke already PASS via config/electron-builder.smoke.cjs).
- GUI walkthrough of the cockpit (widget/flyout/panel) in the dev instance — human eyes.
- Deferred low items: T6-F2 (fleet-route probe vs merged env), replica-hook test note, stale-marker persistence note, terminal-attribution links, non-en stale copy (phase-7).

## Attempts (append-only)
- 2026-07-22 T1..T5 attempt 1: dispatched, opus seats, parallel (disjoint write sets via worktree isolation).
- T2 attempt 1: DONE @56ec7d3 (50 tests, typecheck clean). Blind verify: PASS_WITH_NOTES (all 6 criteria pass; HEAD clean).

## Punch list (batched fixes for integration wave)
- [T2-f1] 404-degraded Routing view shows empty list; display routes read-only from /status as display-only fallback (moderate UX, transition-period only).
- [T2-f2] ipc.ts 404 account-set fallback: add runtime type validation on patch.priority (number) before config write (minor).
- [T5-c1] Contract gap: no per-session routed-ness / live-session-count fields in TcState. T5 uses heuristics (pending activity rows; global reasonKey==='launchedUnrouted'). Spec §4 wants per-SESSION launch-time chips — belongs with T6 seam metadata + a contract rev. Reconcile at integration.
- [T5-c2] Bridge naming: T5 consumes window.api.teamclaude per contract; confirm T4's preload exposes exactly that (single seam: resolveTcBridge).
- [T3-note] pnpm corepack shim added at ~/.local/bin (machine-level; ask user before removing).
- [T3-f1] Windows userData splits across %APPDATA%\orca-tc (early captures) and %APPDATA%\Orca TC (post-setName getPath: daemon runtime, ACL, GPU marker, Chromium profile). Isolated from official either way; unify by adding productName "Orca TC" to package.json + align src/cli/runtime/metadata.ts dir + re-run touched tests. FOREMAN DECISION: unify (verifier recommendation) — batch into integration wave.
- [T3-f2] Cosmetic: PR/issue attribution footers still link stablyai/orca (terminal-attribution.ts:569,603). Optional.
- [T9-c1] TC_MIN_SERVER_VERSION=1.5.0 is a placeholder and WRONG vs reality: Phase 0 SHIPPED as v1.2.0 (teamclaude master @327c0eb). Set constant to '1.2.0' at integration (teamclaude-model.ts).
- [T9-n1] es/ja/ko/zh carry stale English copy for pinHint/stopBodyIdle (append-only consequence) — phase-7 translation item.

## Wave 2 — CLIProxyAPI "Backends" build (2026-07-24)
Spec: orca-ide docs/superpowers/specs/2026-07-24-cliproxyapi-backends-design.md (v1.1 + §12 deltas D1-D11 folded from codex MAX RETHINK + K3 SHIP-WITH-FIXES reviews). Workers: codex gpt-5.6-sol (W2 max, rest xhigh) in ONE shared orca tree, disjoint file sets; teamclaude lane separate. Orchestrator verified every slice outside the worker sandbox before committing.

| Lane | Scope | Result |
|---|---|---|
| W1 | teamclaude POST /teamclaude/account backend fields (upstream/models/modelMap live-apply) + account-scoped upstream-failure holds (never egress breaker) + capability account.backend | VERIFIED @619b3d5 — 38 focused tests, eslint clean |
| W1b | D2 delta: apikey create-on-unknown-id upsert (disk-first + live-register, idempotent), upstream canonicalized to exactly http://127.0.0.1:<port> (path/query/fragment/userinfo rejected), atomicConfigUpdate temp+rename w/ failure unlink; startup already loads apikey accounts (new x-api-key restart test) | VERIFIED @946c245 — full corpus 324: only the known 11 env failures |
| W2 | Generic service-supervisor core (src/main/services) + teamclaude adapter (21/21 floor byte-identical) + cliproxyapi profile (owned-only adoption, dedicated port, owned-unready restart) | VERIFIED @fa111f412 — 74/74 across 9 files |
| W3 | CPA core: config-owner (port 8319, panel off, no is_webui, D11 manifest drift + stop-write-start regen), fail-fast management client (forbidden methods absent), provisioning upsert gated on account.backend, init singleton, IPC w/ isTrustedUIRenderer both directions, settings cliproxyPort/cliproxyBinaryPath | VERIFIED @f3181ad02 (union commit w/ W4) — 34/34 CPA dir |
| W4 | oauth-flows (no is_webui), models-sync (fail-closed EXCLUSIVE route cliproxy-backends, tombstones, generation-serialized), usage-aggregator (whitelist-at-pop, latency reservoir) | VERIFIED, committed in @f3181ad02 — 16/16 |
| W5 | Renderer: Backends tab + 7 subcomponents, ServiceCard/Services tab, useCliproxy hook, backend-account filtering (Accounts/Flyout), 100 i18n keys x5 locales EOL-preserved | VERIFIED @521d300a1 — 66/66 across 11 files, both localization gates |

Integration gates: full node+cli+web typecheck clean; full vitest 31,500 pass / 116 fail across 36 files — ZERO overlap with wave-touched areas (known machine-environmental set: relay/PTY, ssh, hosted-review, native-chat, editor). Seam W4→TC control closed by W3's teamclaude-backend-connector (getRoutes/setRoutes/setAccount). Pushed: gfsaaser24/orca main @f3181ad02, gfsaaser24/teamclaude master @946c245. Live proxy restarted (auto-restarted by supervisor, PID 49740, bootId 090abcf7) — account.backend advertised.

Remaining for CPA feature: download/pin an official CLIProxyAPI release binary + first-run E2E through the Backends tab (needs GUI); installer rebuild when next NSIS wave runs.
