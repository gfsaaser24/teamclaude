import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

export interface TcAccount {
  name: string
  type: 'oauth' | 'apikey'
  orgName?: string | null
  priority?: number
  disabled?: boolean
  source?: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  apiKey?: string
  importFrom?: string
}
export interface TcRoute { name: string; match: string[]; accounts?: string[]; bucket?: string }
export interface TcConfig {
  proxy: { port: number; apiKey: string; host?: string }
  upstream?: string
  switchThreshold?: number
  quotaProbeSeconds?: number
  warmupSeconds?: number
  routes?: TcRoute[]
  accounts: TcAccount[]
  sx?: { apiKey?: string; mode?: string }
}
export interface RedactedAccount extends Omit<TcAccount, 'accessToken' | 'refreshToken' | 'apiKey'> {
  hasCredential: boolean
}
export interface RedactedConfig extends Omit<TcConfig, 'proxy' | 'accounts' | 'sx'> {
  proxy: { port: number; host?: string }
  accounts: RedactedAccount[]
  // The sx apiKey is a secret and must never reach the renderer — only the mode
  // and whether a key is configured are exposed.
  sx?: { mode?: string; hasKey: boolean }
}

// Mirrors src/config.js getConfigPath() so both sides always agree.
export function getTeamclaudeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TEAMCLAUDE_CONFIG) return env.TEAMCLAUDE_CONFIG
  const configDir = env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(configDir, 'teamclaude.json')
}

export async function readTeamclaudeConfig(): Promise<TcConfig | null> {
  let raw: string
  try {
    raw = await readFile(getTeamclaudeConfigPath(), 'utf8')
  } catch (err) {
    // Missing file is the normal "not set up yet" state: null, silently.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  try {
    return JSON.parse(raw) as TcConfig
  } catch (err) {
    // A corrupt config (proxy killed mid-write, bad hand-edit) must not stop the
    // app from booting — treat it as "no usable config" but log so it's visible.
    console.error(`[teamclaude-config] ignoring unparseable config: ${(err as Error).message}`)
    return null
  }
}

export async function updateTeamclaudeConfig(mutator: (cfg: TcConfig) => void): Promise<void> {
  const path = getTeamclaudeConfigPath()
  const cfg = JSON.parse(await readFile(path, 'utf8')) as TcConfig
  mutator(cfg)
  const tmp = `${path}.tmp-desktop`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  await rename(tmp, path)
}

export function redactConfig(cfg: TcConfig): RedactedConfig {
  const { sx, ...rest } = cfg
  return {
    ...rest,
    proxy: { port: cfg.proxy.port, host: cfg.proxy.host },
    accounts: cfg.accounts.map(({ accessToken, refreshToken, apiKey, ...acct }) => ({
      ...acct,
      hasCredential: Boolean(accessToken || apiKey || acct.importFrom),
    })),
    // Strip the sx apiKey — expose only the mode and whether a key is set.
    ...(sx ? { sx: { mode: sx.mode, hasKey: Boolean(sx.apiKey) } } : {}),
  }
}
