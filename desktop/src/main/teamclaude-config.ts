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
}
export interface RedactedAccount extends Omit<TcAccount, 'accessToken' | 'refreshToken' | 'apiKey'> {
  hasCredential: boolean
}
export interface RedactedConfig extends Omit<TcConfig, 'proxy' | 'accounts'> {
  proxy: { port: number; host?: string }
  accounts: RedactedAccount[]
}

// Mirrors src/config.js getConfigPath() so both sides always agree.
export function getTeamclaudeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TEAMCLAUDE_CONFIG) return env.TEAMCLAUDE_CONFIG
  const configDir = env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(configDir, 'teamclaude.json')
}

export async function readTeamclaudeConfig(): Promise<TcConfig | null> {
  try {
    return JSON.parse(await readFile(getTeamclaudeConfigPath(), 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
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
  return {
    ...cfg,
    proxy: { port: cfg.proxy.port, host: cfg.proxy.host },
    accounts: cfg.accounts.map(({ accessToken, refreshToken, apiKey, ...rest }) => ({
      ...rest,
      hasCredential: Boolean(accessToken || apiKey || rest.importFrom),
    })),
  }
}
