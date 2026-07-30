// Invalidate Claude Code's cached account identity when the pin changes.
//
// Why this exists: `claude`'s /status does NOT ask the proxy who is serving
// requests — it prints `oauthAccount` out of ~/.claude.json, a profile snapshot
// the CLI writes once and refreshes rarely (observed 13h stale in the field).
// The proxy serves /api/oauth/profile with the PINNED account's token, so after
// a re-pin the cached snapshot and the account actually answering requests
// silently disagree, and /status stops being a usable check on where traffic is
// going — which is exactly what people use it for.
//
// We DELETE the key rather than rewrite it. Rewriting would mean synthesizing
// ~15 fields we do not own (billingType, organizationType, rate-limit tiers,
// onboarding flags); a partial object is worse than none. Deleting makes the CLI
// refetch through the proxy on next launch and store a complete, provider-
// authored object for the account that is really serving it.
//
// Everything here is best-effort: this file belongs to Claude Code, not to us,
// and failing to tidy a cache must never break pinning.

import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

/**
 * Where Claude Code keeps the config carrying `oauthAccount`.
 *
 * TEAMCLAUDE_CLAUDE_CONFIG is an explicit override (used by the tests, and an
 * escape hatch if the CLI ever moves the file). CLAUDE_CONFIG_DIR is honoured
 * because Orca sets it when it isolates a session's config; when neither is set
 * the file is a sibling of the home directory, NOT inside ~/.claude.
 */
export function claudeConfigPath(env = process.env) {
  if (env.TEAMCLAUDE_CLAUDE_CONFIG) return env.TEAMCLAUDE_CLAUDE_CONFIG;
  if (env.CLAUDE_CONFIG_DIR) return join(env.CLAUDE_CONFIG_DIR, '.claude.json');
  return join(homedir(), '.claude.json');
}

/**
 * Drop the cached `oauthAccount` so the next `claude` launch refetches it
 * through the proxy.
 *
 * `accountUuid` is the UUID of the account now being pinned. When the cache
 * already names that account there is nothing stale to clear, so we leave the
 * file untouched — re-pinning to the account you are already on should not cost
 * a profile refetch.
 *
 * Returns a result object describing what happened; never throws.
 */
export function invalidateClaudeIdentity({ accountUuid = null, env = process.env } = {}) {
  const path = claudeConfigPath(env);
  try {
    if (!existsSync(path)) return { ok: true, changed: false, reason: 'no-config-file' };

    let parsed;
    const raw = readFileSync(path, 'utf8');
    try {
      parsed = JSON.parse(raw.replace(/^﻿/, ''));
    } catch {
      // Someone else's file, mid-write or hand-edited. Never "repair" it.
      return { ok: false, changed: false, reason: 'unparseable' };
    }
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, changed: false, reason: 'unparseable' };
    }

    const cached = parsed.oauthAccount;
    if (!cached || typeof cached !== 'object') {
      return { ok: true, changed: false, reason: 'no-cached-identity' };
    }
    if (accountUuid && cached.accountUuid === accountUuid) {
      return { ok: true, changed: false, reason: 'already-matches' };
    }

    const previous = typeof cached.emailAddress === 'string' ? cached.emailAddress : null;
    delete parsed.oauthAccount;

    // Atomic swap, mirroring atomicConfigUpdate in config.js: a torn 110 KB
    // config would cost the user their whole CLI state, and Claude Code may be
    // writing this file concurrently.
    const tempPath = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    try {
      writeFileSync(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
      renameSync(tempPath, path);
    } catch (err) {
      try { unlinkSync(tempPath); } catch { /* temp already gone */ }
      throw err;
    }
    return { ok: true, changed: true, reason: 'invalidated', previous };
  } catch (err) {
    return { ok: false, changed: false, reason: 'write-failed', error: err?.message ?? String(err) };
  }
}
