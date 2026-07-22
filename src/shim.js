// `claude` PATH shim (Windows) — install/uninstall/status.
//
// The Unix `alias` command only covers interactive shells; editors and tools
// that exec `claude` themselves (Orca, SDK spawns, shell:true child processes)
// never see it. On Windows the equivalent with real coverage is a PATH shim:
// three launchers named `claude` in ~/.teamclaude/bin — claude.cmd (cmd.exe and
// Node shell:true spawns), claude.ps1 (PowerShell), claude (Git Bash) — with
// that dir prepended to the *user* PATH so it wins over the real install.
//
// Each shim is a dumb passthrough into `teamclaude run --`, which keeps all the
// smarts (proxy probe, MITM env, direct fallback when the proxy is down) — the
// same philosophy as the shell alias (src/alias.js). Recursion is broken by an
// env guard: `run` sets TEAMCLAUDE_RUN_GUARD=1 when spawning `claude`, and a
// guarded shim execs the real binary (baked in at install time) directly
// instead of looping back into `run`.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export const MARKER = 'teamclaude-shim';

export function shimDir() {
  return join(homedir(), '.teamclaude', 'bin');
}

/** C:\Users\x → /c/Users/x, for the Git Bash shim. */
export function toPosixPath(winPath) {
  return winPath
    .replace(/^([A-Za-z]):[\\/]/, (_, d) => `/${d.toLowerCase()}/`)
    .replaceAll('\\', '/');
}

/** True if a file looks like one of ours (so discovery/uninstall skip it). */
function isShimFile(file) {
  try {
    return readFileSync(file, 'utf8').slice(0, 400).includes(MARKER);
  } catch {
    return false;
  }
}

/**
 * First real launcher for a tool on a PATH string, skipping our own shim dir
 * and any file carrying the shim marker. Prefers .exe (native installs) over
 * .cmd (npm wrappers) within each dir.
 */
export function findRealTool(tool, pathStr = process.env.PATH || '', skipDir = shimDir()) {
  const skip = skipDir.toLowerCase();
  for (const dir of pathStr.split(';')) {
    if (!dir || dir.toLowerCase() === skip) continue;
    for (const ext of ['.exe', '.cmd', '.bat']) {
      const candidate = join(dir, tool + ext);
      if (existsSync(candidate) && !isShimFile(candidate)) return candidate;
    }
  }
  return null;
}

export function findRealClaude(pathStr = process.env.PATH || '', skipDir = shimDir()) {
  return findRealTool('claude', pathStr, skipDir);
}

/** Whether bare `teamclaude` resolves on the current PATH (Windows launchers). */
function teamclaudeOnPath() {
  for (const dir of (process.env.PATH || '').split(';')) {
    if (!dir) continue;
    for (const name of ['teamclaude.cmd', 'teamclaude.ps1', 'teamclaude.exe', 'teamclaude']) {
      if (existsSync(join(dir, name))) return true;
    }
  }
  return false;
}

/**
 * Per-syntax `teamclaude run [flags] --` invocations. When teamclaude isn't on
 * PATH (e.g. run from a clone) the shims embed `node <abs entry>` instead,
 * same idea as alias.js's teamclaudeRef().
 */
export function teamclaudeInvocations(runFlags = []) {
  const flags = runFlags.length ? runFlags.join(' ') + ' ' : '';
  if (teamclaudeOnPath()) {
    return {
      cmd: `teamclaude run ${flags}-- %*`,
      ps1: `& teamclaude run ${flags}'--' @args`,
      sh: `exec teamclaude run ${flags}-- "$@"`,
    };
  }
  const entry = process.argv[1] || 'teamclaude';
  return {
    cmd: `node "${entry}" run ${flags}-- %*`,
    ps1: `& node "${entry}" run ${flags}'--' @args`,
    sh: `exec node "${toPosixPath(entry)}" run ${flags}-- "$@"`,
  };
}

// ── shim file contents (pure) ───────────────────────────────
//
// `presetEnv` entries ({name, value}) are set before either branch runs, but
// never override a value already in the environment. Used to pin wrapper
// tools' own resolution (e.g. HAPPY_CLAUDE_PATH) to the real binary.

export function cmdShim(tool, realPath, invoke, presetEnv = []) {
  // The unguarded line chains into teamclaude.cmd without `call`: control
  // transfers in tail position and its exit code becomes ours.
  return [
    '@echo off',
    `rem ${MARKER} — routes bare \`${tool}\` through the TeamClaude proxy.`,
    'rem Regenerate with: teamclaude shim install',
    ...presetEnv.map(e => `if not defined ${e.name} set "${e.name}=${e.value}"`),
    'if "%TEAMCLAUDE_RUN_GUARD%"=="1" goto direct',
    invoke.cmd,
    'exit /b %ERRORLEVEL%',
    ':direct',
    `"${realPath}" %*`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

export function ps1Shim(tool, realPath, invoke, presetEnv = []) {
  return [
    `# ${MARKER} — routes bare \`${tool}\` through the TeamClaude proxy.`,
    '# Regenerate with: teamclaude shim install',
    ...presetEnv.map(e => `if (-not $env:${e.name}) { $env:${e.name} = '${e.value}' }`),
    "if ($env:TEAMCLAUDE_RUN_GUARD -eq '1') {",
    `  & "${realPath}" @args`,
    '  exit $LASTEXITCODE',
    '}',
    invoke.ps1,
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n');
}

export function shShim(tool, realPath, invoke, presetEnv = []) {
  return [
    '#!/bin/sh',
    `# ${MARKER} — routes bare \`${tool}\` through the TeamClaude proxy.`,
    '# Regenerate with: teamclaude shim install',
    ...presetEnv.map(e => `[ -n "$${e.name}" ] || { ${e.name}="${e.value}"; export ${e.name}; }`),
    'if [ "$TEAMCLAUDE_RUN_GUARD" = "1" ]; then',
    `  exec "${toPosixPath(realPath)}" "$@"`,
    'fi',
    invoke.sh,
    '',
  ].join('\n');
}

// ── user PATH list handling (pure) ──────────────────────────

/** Prepend dir to a ;-separated PATH string unless already present (case-insensitive). */
export function prependToPathList(pathStr, dir) {
  const entries = (pathStr || '').split(';').filter(Boolean);
  if (entries.some(e => e.toLowerCase() === dir.toLowerCase())) return pathStr;
  return [dir, ...entries].join(';');
}

/** Remove dir from a ;-separated PATH string (case-insensitive). */
export function removeFromPathList(pathStr, dir) {
  return (pathStr || '')
    .split(';')
    .filter(e => e && e.toLowerCase() !== dir.toLowerCase())
    .join(';');
}

// ── user PATH registry access ───────────────────────────────
//
// Via .NET rather than setx: setx silently truncates values over 1024 chars
// (real user PATHs exceed that), while SetEnvironmentVariable handles any
// length and broadcasts WM_SETTINGCHANGE so newly launched apps see the
// change. Caveat: reading returns the expanded value, so a REG_EXPAND_SZ
// PATH with %VAR% references would be rewritten literal — same tradeoff most
// installers make.

function psRun(script) {
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`powershell exited ${result.status}: ${(result.stderr || '').trim()}`);
  }
  return (result.stdout || '').replace(/\r?\n$/, '');
}

function getUserPath() {
  return psRun("[Environment]::GetEnvironmentVariable('Path','User')");
}

function setUserPath(value) {
  const escaped = value.replace(/'/g, "''");
  psRun(`[Environment]::SetEnvironmentVariable('Path','${escaped}','User')`);
}

// ── commands ────────────────────────────────────────────────

function requireWindows() {
  if (process.platform !== 'win32') {
    console.error("The PATH shim is Windows-only. On this platform use: teamclaude alias --install");
    process.exit(1);
  }
}

/**
 * Shimmed tools. `claude` is intercepted directly. Wrapper launchers that
 * spawn claude themselves (and pass their env through to it) are run with
 * `run --exec <tool>` so the routed env reaches the claude they spawn;
 * presetEnv pins their claude resolution to the real binary so they don't
 * trip over our claude shim on PATH.
 */
function shimTargets(realClaude) {
  return [
    { tool: 'claude', real: () => realClaude, runFlags: [], presetEnv: [], required: true },
    {
      tool: 'happy',
      real: () => findRealTool('happy'),
      runFlags: ['--exec', 'happy'],
      presetEnv: [{ name: 'HAPPY_CLAUDE_PATH', value: realClaude }],
      required: false,
    },
  ];
}

const SHIM_EXTS = ['.cmd', '.ps1', ''];

export function installShim() {
  requireWindows();
  const dir = shimDir();

  const realClaude = findRealClaude();
  if (!realClaude) {
    console.error('Claude Code not found in PATH. Install it first, then rerun: teamclaude shim install');
    process.exit(1);
  }

  mkdirSync(dir, { recursive: true });
  const installed = [];
  for (const t of shimTargets(realClaude)) {
    const real = t.real();
    if (!real) {
      if (t.required) {
        console.error(`${t.tool} not found in PATH.`);
        process.exit(1);
      }
      continue;
    }
    const invoke = teamclaudeInvocations(t.runFlags);
    writeFileSync(join(dir, `${t.tool}.cmd`), cmdShim(t.tool, real, invoke, t.presetEnv));
    writeFileSync(join(dir, `${t.tool}.ps1`), ps1Shim(t.tool, real, invoke, t.presetEnv));
    writeFileSync(join(dir, t.tool), shShim(t.tool, real, invoke, t.presetEnv));
    installed.push(`${t.tool} → ${real}`);
  }

  const userPath = getUserPath();
  const updated = prependToPathList(userPath, dir);
  const pathChanged = updated !== userPath;
  if (pathChanged) setUserPath(updated);

  console.log(`Shims installed in ${dir}:`);
  for (const line of installed) console.log(`  ${line}`);
  console.log(pathChanged
    ? 'User PATH updated (prepended). Restart terminals/apps to pick it up.'
    : 'User PATH already contains the shim dir.');
  console.log('Shimmed launches route through the proxy; when it is down they fall through directly.');
}

export function uninstallShim() {
  requireWindows();
  const dir = shimDir();

  const userPath = getUserPath();
  const updated = removeFromPathList(userPath, dir);
  if (updated !== userPath) setUserPath(updated);

  if (existsSync(dir)) {
    // Only delete files that carry our marker; leave anything else alone.
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (isShimFile(file)) rmSync(file);
    }
    if (readdirSync(dir).length === 0) {
      rmSync(dir, { recursive: true });
      const parent = dirname(dir);
      if (existsSync(parent) && readdirSync(parent).length === 0) rmSync(parent, { recursive: true });
    }
  }
  console.log('Shim removed and user PATH cleaned. Restart terminals/apps to pick it up.');
}

export function shimStatus() {
  requireWindows();
  const dir = shimDir();
  const realClaude = findRealClaude();
  const targets = shimTargets(realClaude);
  const claudeFiles = SHIM_EXTS.map(ext => `claude${ext}`);
  const installed = targets.flatMap(t =>
    SHIM_EXTS.map(ext => `${t.tool}${ext}`)
      .filter(f => existsSync(join(dir, f)) && isShimFile(join(dir, f))));
  const onUserPath = getUserPath()
    .split(';')
    .some(e => e.toLowerCase() === dir.toLowerCase());

  console.log(`Shim dir:     ${dir}`);
  console.log(`Shim files:   ${installed.length ? installed.join(', ') : '(none)'}`);
  console.log(`On user PATH: ${onUserPath ? 'yes' : 'no'}`);
  console.log(`Real claude:  ${realClaude || 'not found'}`);
  if (claudeFiles.every(f => installed.includes(f)) && onUserPath) {
    console.log('Status:       active — shimmed launches route through the proxy in new terminals/apps');
  } else if (installed.length || onUserPath) {
    console.log('Status:       partial — rerun: teamclaude shim install');
  } else {
    console.log('Status:       not installed — run: teamclaude shim install');
  }
}

export function shimCommand(sub) {
  switch (sub) {
    case 'install':
      installShim();
      break;
    case 'uninstall':
      uninstallShim();
      break;
    case 'status':
    case undefined:
      shimStatus();
      break;
    default:
      console.error(`Unknown shim subcommand: ${sub} (expected install|uninstall|status)`);
      process.exit(1);
  }
}
