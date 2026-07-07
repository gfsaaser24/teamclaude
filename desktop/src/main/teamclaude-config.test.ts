import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getTeamclaudeConfigPath, readTeamclaudeConfig, updateTeamclaudeConfig, redactConfig } from './teamclaude-config'

const dirs: string[] = []
function tmpConfig(content: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'tcd-cfg-'))
  dirs.push(dir)
  const p = join(dir, 'teamclaude.json')
  writeFileSync(p, JSON.stringify(content))
  process.env.TEAMCLAUDE_CONFIG = p
  return p
}
afterEach(() => {
  delete process.env.TEAMCLAUDE_CONFIG
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('getTeamclaudeConfigPath', () => {
  it('honors TEAMCLAUDE_CONFIG, then XDG_CONFIG_HOME, then ~/.config', () => {
    expect(getTeamclaudeConfigPath({ TEAMCLAUDE_CONFIG: 'C:\\x\\tc.json' })).toBe('C:\\x\\tc.json')
    expect(getTeamclaudeConfigPath({ XDG_CONFIG_HOME: 'C:\\xdg' })).toBe(join('C:\\xdg', 'teamclaude.json'))
    expect(getTeamclaudeConfigPath({})).toContain(join('.config', 'teamclaude.json'))
  })
})

describe('read/update/redact', () => {
  const base = {
    proxy: { port: 3456, apiKey: 'tc-secret' },
    accounts: [
      { name: 'a@x.com', type: 'oauth', accessToken: 'sk-ant-oat-AAA', refreshToken: 'r', expiresAt: 1 },
      { name: 'api-1', type: 'apikey', apiKey: 'sk-ant-api-BBB', priority: 5 },
    ],
    routes: [{ name: 'opus', match: ['claude-opus-*'], accounts: ['a@x.com'] }],
  }

  it('reads the config from TEAMCLAUDE_CONFIG', async () => {
    tmpConfig(base)
    const cfg = await readTeamclaudeConfig()
    expect(cfg?.proxy.port).toBe(3456)
    expect(cfg?.accounts).toHaveLength(2)
  })

  it('returns null when the file does not exist', async () => {
    process.env.TEAMCLAUDE_CONFIG = join(tmpdir(), 'nope', 'missing.json')
    expect(await readTeamclaudeConfig()).toBeNull()
  })

  it('updateTeamclaudeConfig persists mutations atomically', async () => {
    const p = tmpConfig(base)
    await updateTeamclaudeConfig(cfg => { cfg.accounts[1].disabled = true })
    const onDisk = JSON.parse(readFileSync(p, 'utf8'))
    expect(onDisk.accounts[1].disabled).toBe(true)
    expect(onDisk.proxy.apiKey).toBe('tc-secret') // rest preserved
  })

  it('redactConfig strips every credential and flags presence', () => {
    const red = redactConfig(base as never)
    const json = JSON.stringify(red)
    expect(json).not.toContain('sk-ant-oat-AAA')
    expect(json).not.toContain('sk-ant-api-BBB')
    expect(json).not.toContain('tc-secret')
    expect(red.accounts[0].hasCredential).toBe(true)
    expect(red.proxy.port).toBe(3456)
  })
})
