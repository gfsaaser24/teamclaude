import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY = resolve(fileURLToPath(import.meta.url), '..', '..', 'src', 'index.js');

function freePort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

async function waitForStatus(port, key, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, { headers: { 'x-api-key': key } });
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('server did not become ready');
}

test('server --headless exposes the version/bootId/capabilities envelope + account identity', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-headless-'));
  const cfgPath = join(dir, 'teamclaude.json');
  const port = await freePort();
  writeFileSync(cfgPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-int-key' },
    upstream: 'https://api.anthropic.com',
    accounts: [{ name: 'k1', type: 'apikey', apiKey: 'sk-test' }],
  }));

  const env = { ...process.env, TEAMCLAUDE_CONFIG: cfgPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' };
  const child = spawn(process.execPath, [ENTRY, 'server', '--headless'], { env, stdio: 'ignore' });
  try {
    const status = await waitForStatus(port, 'tc-int-key');
    assert.equal(typeof status.version, 'string');           // from updater.currentVersion()
    assert.equal(typeof status.bootId, 'string');
    assert.ok(Array.isArray(status.capabilities));
    assert.ok(status.capabilities.includes('routes.rw'));
    assert.ok(status.capabilities.includes('status.identity'));

    const acct = status.accounts[0];
    assert.equal(acct.id, 'name:k1');                        // stable id (API-key fallback)
    assert.ok('email' in acct);
    assert.equal(typeof acct.observedAt, 'object');

    // /log echoes the same bootId as /status.
    const log = await (await fetch(`http://127.0.0.1:${port}/teamclaude/log`, { headers: { 'x-api-key': 'tc-int-key' } })).json();
    assert.equal(log.bootId, status.bootId);

    // GET /routes works (empty here) and returns the editable shape.
    const routes = await (await fetch(`http://127.0.0.1:${port}/teamclaude/routes`, { headers: { 'x-api-key': 'tc-int-key' } })).json();
    assert.deepEqual(routes.routes, []);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('server --headless exits 3 (setup-needed) when zero accounts are configured', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-noacct-'));
  const cfgPath = join(dir, 'teamclaude.json'); // does not exist → default empty-accounts config
  try {
    const r = spawnSync(process.execPath, [ENTRY, 'server', '--headless'], {
      env: { ...process.env, TEAMCLAUDE_CONFIG: cfgPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(r.status, 3, `expected exit 3, got ${r.status} (stderr: ${r.stderr})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('server (interactive path) exits 1 — not 3 — with zero accounts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-noacct1-'));
  const cfgPath = join(dir, 'teamclaude.json');
  try {
    // No --headless: the distinct setup-needed code is headless-only.
    const r = spawnSync(process.execPath, [ENTRY, 'server'], {
      env: { ...process.env, TEAMCLAUDE_CONFIG: cfgPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status} (stderr: ${r.stderr})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
