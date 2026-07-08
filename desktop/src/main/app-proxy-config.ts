import { readFile, writeFile, rename, mkdir, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'

/**
 * The desktop runs its OWN teamclaude proxy, on its OWN port, from its OWN
 * config file — never the user's shared ~/.config/teamclaude.json and never
 * whatever else happens to be on port 3456. That makes launching the app the
 * only step: it can't collide with, or accidentally attach to, another proxy.
 */

export interface AppProxyInfo {
  path: string
  port: number
  apiKey: string
  accountCount: number
}

/** Resolve a bindable loopback port: try `preferred`, else an OS-assigned one. */
export async function findFreePort(preferred = 51789): Promise<number> {
  const attempt = (p: number): Promise<number | null> =>
    new Promise(resolve => {
      const s = createServer()
      s.once('error', () => resolve(null))
      s.listen(p, '127.0.0.1', () => {
        const addr = s.address()
        const got = typeof addr === 'object' && addr ? addr.port : p
        s.close(() => resolve(got))
      })
    })
  return (await attempt(preferred)) ?? (await attempt(0)) ?? preferred
}

/**
 * Ensure the app's dedicated proxy config exists and return its port/apiKey.
 * A valid existing config is reused (stable port across launches). A missing or
 * corrupt one is (re)provisioned with a free port, a fresh key, and accounts
 * copied once from the user's shared config so they don't start from scratch.
 */
export async function ensureAppProxyConfig({ configPath, sharedConfigPath }: {
  configPath: string
  sharedConfigPath?: string
}): Promise<AppProxyInfo> {
  if (existsSync(configPath)) {
    try {
      const c = JSON.parse(await readFile(configPath, 'utf8'))
      if (c?.proxy?.port) {
        return { path: configPath, port: c.proxy.port, apiKey: c.proxy.apiKey ?? '', accountCount: (c.accounts ?? []).length }
      }
    } catch {
      // Corrupt — preserve it for inspection, then re-provision below.
      try { await copyFile(configPath, configPath + '.bak') } catch { /* best effort */ }
    }
  }

  const port = await findFreePort()
  const apiKey = 'tc-' + randomBytes(24).toString('base64url')
  let accounts: unknown[] = []
  if (sharedConfigPath && existsSync(sharedConfigPath)) {
    try { accounts = JSON.parse(await readFile(sharedConfigPath, 'utf8')).accounts ?? [] } catch { /* leave empty */ }
  }

  const cfg = { proxy: { port, apiKey }, accounts }
  await mkdir(dirname(configPath), { recursive: true })
  const tmp = configPath + '.tmp'
  await writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  await rename(tmp, configPath)
  return { path: configPath, port, apiKey, accountCount: accounts.length }
}
