#!/usr/bin/env node
// Prints every model TeamClaude will route, grouped by provider family.
//
// Why this exists: Claude Code's `/model` picker is a fixed list plus at most
// five env-configurable slots (four tier overrides + ANTHROPIC_CUSTOM_MODEL_OPTION),
// so a fleet with dozens of routed backend models cannot be browsed there. Every
// one of them is still usable by exact id, which makes this a discovery gap, not
// a capability gap — this report closes it.
//
// Read-only: it only GETs /teamclaude/routes and /teamclaude/status, neither of
// which requires the proxy API key (mutations do).

import { loadConfig } from '../../src/config.js'

const FAMILIES = [
  { label: 'Claude (fleet)', test: (id) => /^claude-/i.test(id) },
  { label: 'Codex / ChatGPT', test: (id) => /^(gpt|codex)-/i.test(id) },
  { label: 'Grok / xAI', test: (id) => /^grok-/i.test(id) },
  { label: 'Kimi', test: (id) => /^kimi-/i.test(id) },
  { label: 'Gemini / Antigravity', test: (id) => /^(gemini|antigravity)-/i.test(id) }
]

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`${url} responded ${res.status}`)
  return res.json()
}

function familyOf(id) {
  return FAMILIES.find((f) => f.test(id))?.label ?? 'Other'
}

async function main() {
  let port = 3456
  try {
    const config = await loadConfig()
    if (Number.isInteger(config?.proxy?.port)) port = config.proxy.port
  } catch {
    // Fall back to the default port — the report is still useful.
  }
  const base = `http://127.0.0.1:${port}`

  let routes
  let status
  try {
    ;[routes, status] = await Promise.all([
      getJson(`${base}/teamclaude/routes`),
      getJson(`${base}/teamclaude/status`)
    ])
  } catch (error) {
    console.log(`TeamClaude proxy is not reachable on ${base} (${error.message}).`)
    console.log('Start it, then run /models-tc again.')
    process.exitCode = 1
    return
  }

  const accounts = status.accounts ?? []
  const backendNames = new Set(
    accounts.filter((a) => a.name === 'cliproxy' || a.upstream).map((a) => a.name)
  )

  // Model id -> the route that governs it, so each entry shows where it lands.
  const byFamily = new Map()
  for (const route of routes.routes ?? []) {
    for (const id of route.match ?? []) {
      const family = familyOf(id)
      if (!byFamily.has(family)) byFamily.set(family, [])
      byFamily.get(family).push({ id, route: route.name })
    }
  }

  const fleetCount = accounts.filter((a) => !backendNames.has(a.name)).length
  console.log(`TeamClaude routed models — proxy ${status.version ?? '?'} on ${base}`)
  console.log(`${fleetCount} Claude account(s) + ${backendNames.size} backend bridge(s)\n`)

  if (byFamily.size === 0) {
    console.log('No routes are configured, so no model is pinned to a specific account.')
    console.log('Unrouted models still work — selection falls back to any eligible account.')
    return
  }

  // Numbered within each family so a paginated picker can page by index rather
  // than by recall — "next three" has to be mechanical, or entries get repeated.
  const order = [...FAMILIES.map((f) => f.label), 'Other']
  for (const family of order) {
    const entries = byFamily.get(family)
    if (!entries?.length) continue
    console.log(`${family}  (${entries.length} model${entries.length === 1 ? '' : 's'})`)
    const sorted = entries.sort((a, b) => a.id.localeCompare(b.id))
    sorted.forEach(({ id, route }, i) => {
      const n = String(i + 1).padStart(2)
      console.log(`  ${n}. ${id.padEnd(34)} route: ${route}`)
    })
    console.log('')
  }

  console.log('Use any id above:')
  console.log('  claude --model <id>        (new session)')
  console.log('  /model <id>                (in an existing session)')
}

main().catch((error) => {
  console.log(`Could not build the model report: ${error.message}`)
  process.exitCode = 1
})
