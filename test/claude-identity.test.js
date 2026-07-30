// Clearing Claude Code's cached account identity on re-pin.
//
// The file under test belongs to Claude Code, not to us, so most of these cases
// are about NOT touching it: unparseable, absent, already correct. The one write
// path must be atomic and must preserve every other key — that config carries
// the user's whole CLI state (~110 KB in the field), so a clobber is expensive.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invalidateClaudeIdentity, claudeConfigPath } from '../src/claude-identity.js';

function scratchConfig(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'tc-identity-'));
  const path = join(dir, '.claude.json');
  if (contents !== undefined) {
    writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2), 'utf8');
  }
  return { dir, path, env: { TEAMCLAUDE_CLAUDE_CONFIG: path } };
}

const IDENTITY = {
  accountUuid: '28813d3b-fece-418d-8ca9-23211eb07e4c',
  emailAddress: 'gabe@editmypodcast.agency',
  organizationName: "gabe@editmypodcast.agency's Organization"
};

test('clears the cached identity and reports which account it dropped', () => {
  const { path, env } = scratchConfig({ numStartups: 341, oauthAccount: IDENTITY, projects: { a: 1 } });

  const result = invalidateClaudeIdentity({ accountUuid: '5bf3f70f-a50b-4d20-b413-dc90b7a9cfca', env });

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.previous, 'gabe@editmypodcast.agency');
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal('oauthAccount' in after, false);
});

test('preserves every other key — the config is the user\'s whole CLI state', () => {
  const original = {
    numStartups: 341,
    installMethod: 'native',
    oauthAccount: IDENTITY,
    projects: { '/a': { history: [1, 2, 3] } },
    mcpServers: { x: { command: 'y' } },
    tipsHistory: { t: 9 }
  };
  const { path, env } = scratchConfig(original);

  invalidateClaudeIdentity({ accountUuid: 'different-uuid', env });

  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(Object.keys(after).sort(), ['installMethod', 'mcpServers', 'numStartups', 'projects', 'tipsHistory']);
  assert.deepEqual(after.projects, original.projects);
  assert.deepEqual(after.mcpServers, original.mcpServers);
  assert.equal(after.numStartups, 341);
});

test('leaves the file alone when the cache already names the pinned account', () => {
  const { path, env } = scratchConfig({ oauthAccount: IDENTITY });
  const before = readFileSync(path, 'utf8');

  const result = invalidateClaudeIdentity({ accountUuid: IDENTITY.accountUuid, env });

  assert.equal(result.changed, false);
  assert.equal(result.reason, 'already-matches');
  assert.equal(readFileSync(path, 'utf8'), before, 'byte-identical: no needless refetch');
});

test('is a no-op when there is no cached identity to clear', () => {
  const { env } = scratchConfig({ numStartups: 1 });
  const result = invalidateClaudeIdentity({ accountUuid: 'anything', env });
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'no-cached-identity');
});

test('is a no-op when the config does not exist', () => {
  const { env } = scratchConfig(undefined);
  const result = invalidateClaudeIdentity({ accountUuid: 'anything', env });
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'no-config-file');
});

test('never rewrites a config it cannot parse', () => {
  const { path, env } = scratchConfig('{ this is not json');
  const result = invalidateClaudeIdentity({ accountUuid: 'anything', env });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unparseable');
  assert.equal(readFileSync(path, 'utf8'), '{ this is not json', 'a half-written file must survive untouched');
});

test('reports failure instead of throwing, so a pin can never fail on this', () => {
  // Point at a path whose parent does not exist: existsSync is false, so this
  // resolves as a clean no-op rather than an exception escaping into pinAccount.
  const result = invalidateClaudeIdentity({
    accountUuid: 'anything',
    env: { TEAMCLAUDE_CLAUDE_CONFIG: join(tmpdir(), 'tc-does-not-exist-dir', 'nested', '.claude.json') }
  });
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
});

test('leaves no temp files behind after a successful swap', () => {
  const { dir, env } = scratchConfig({ oauthAccount: IDENTITY });
  invalidateClaudeIdentity({ accountUuid: 'different-uuid', env });
  const strays = readdirSync(dir).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(strays, []);
});

test('path resolution: explicit override beats CLAUDE_CONFIG_DIR beats home', () => {
  assert.equal(
    claudeConfigPath({ TEAMCLAUDE_CLAUDE_CONFIG: '/explicit/.claude.json', CLAUDE_CONFIG_DIR: '/dir' }),
    '/explicit/.claude.json'
  );
  assert.equal(claudeConfigPath({ CLAUDE_CONFIG_DIR: join('/dir') }), join('/dir', '.claude.json'));
  const fromHome = claudeConfigPath({});
  assert.equal(existsSync(fromHome) || fromHome.endsWith('.claude.json'), true);
});
