import { execFile, spawn } from 'node:child_process'

/**
 * "Wrap the real teamclaude" installer. The desktop app prefers running the
 * user's actual global `teamclaude` (installed via npm) over the bundled proxy
 * copy — so it stays byte-for-byte identical to what the CLI runs. This module
 * detects the global install, drives an npm install of it, and picks the launch
 * command (real install when present, bundled fallback otherwise).
 */

const PACKAGE = '@karpeleslab/teamclaude'

/** True if the `teamclaude` bin resolves on PATH (a real global install). */
export async function isTeamclaudeInstalled(): Promise<boolean> {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  return await new Promise<boolean>(resolve => {
    // exit 0 → found on PATH; any error (not found / tool missing) → not installed.
    execFile(finder, ['teamclaude'], { windowsHide: true }, err => resolve(!err))
  })
}

/**
 * Install the global `teamclaude` via `npm install -g @karpeleslab/teamclaude`,
 * streaming stdout+stderr line-by-line to `onLine` (for onboarding UI). Resolves
 * `{ ok: true }` on success; `{ ok: false, error }` on failure — with a friendly
 * message when npm itself isn't present.
 */
export async function installTeamclaude(
  onLine: (line: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  return await new Promise(resolve => {
    let settled = false
    let lastErr = ''
    // shell:true on Windows resolves the `npm.cmd` shim via PATHEXT.
    const child = spawn('npm', ['install', '-g', PACKAGE], {
      shell: process.platform === 'win32',
      windowsHide: true,
    })
    const emit = (chunk: Buffer, isErr: boolean): void => {
      for (const raw of chunk.toString().split('\n')) {
        const line = raw.replace(/\r$/, '')
        if (!line.trim()) continue
        if (isErr) lastErr = line
        onLine(line)
      }
    }
    child.stdout?.on('data', (c: Buffer) => emit(c, false))
    child.stderr?.on('data', (c: Buffer) => emit(c, true))
    // Spawn failure (npm missing / not on PATH) — surface a fix-it message.
    child.on('error', () => {
      if (settled) return
      settled = true
      resolve({ ok: false, error: 'npm not found — install Node.js' })
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      if (code === 0) resolve({ ok: true })
      else resolve({ ok: false, error: lastErr || 'npm install failed' })
    })
  })
}

export interface ProxyLaunch {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
}

/**
 * Choose how to launch the proxy. When the global `teamclaude` is installed we
 * run it directly (the robust path — no ELECTRON_RUN_AS_NODE, no bundled copy).
 * Otherwise fall back to the bundled proxy entry, run under the packaged app's
 * Electron-as-node (or plain `node` in dev) exactly as before.
 */
export function preferredProxyLaunch(opts: {
  installed: boolean
  isPackaged: boolean
  bundledEntry: string
  packagedNode: string
}): ProxyLaunch {
  if (opts.installed) {
    return { command: 'teamclaude', args: ['server', '--headless'] }
  }
  return {
    command: opts.isPackaged ? opts.packagedNode : 'node',
    args: [opts.bundledEntry, 'server', '--headless'],
    env: opts.isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : undefined,
  }
}
