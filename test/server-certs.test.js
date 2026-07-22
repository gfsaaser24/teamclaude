import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { caCertPath } from '../src/mitm.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function am() {
  return new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k' }], 0.98);
}

// certs land next to the config; point TEAMCLAUDE_CONFIG at a temp dir so the
// endpoint's ensureCerts writes there and we can assert on the real file.
async function withCertDir(run) {
  const prev = process.env.TEAMCLAUDE_CONFIG;
  const dir = mkdtempSync(join(tmpdir(), 'tc-certs-'));
  process.env.TEAMCLAUDE_CONFIG = join(dir, 'teamclaude.json');
  try { return await run(dir); }
  finally {
    if (prev === undefined) delete process.env.TEAMCLAUDE_CONFIG; else process.env.TEAMCLAUDE_CONFIG = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('POST /teamclaude/certs/ensure generates the CA and returns its caPath', { timeout: 20000 }, async () => {
  await withCertDir(async () => {
    const proxy = createProxyServer(am(), { proxy: { apiKey: 'k' }, upstream: 'https://api.anthropic.com' }, {});
    const port = await listen(proxy);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/teamclaude/certs/ensure`, {
        method: 'POST', headers: { 'x-api-key': 'k' },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.caPath, caCertPath());       // derived path, as the CONNECT path uses
      assert.ok(existsSync(body.caPath), 'CA cert file was written');
    } finally { proxy.close(); }
  });
});

test('certs/ensure is idempotent — a second call returns the same caPath', { timeout: 20000 }, async () => {
  await withCertDir(async () => {
    const proxy = createProxyServer(am(), { proxy: { apiKey: 'k' }, upstream: 'https://api.anthropic.com' }, {});
    const port = await listen(proxy);
    try {
      const p1 = (await (await fetch(`http://127.0.0.1:${port}/teamclaude/certs/ensure`, { method: 'POST', headers: { 'x-api-key': 'k' } })).json()).caPath;
      const p2 = (await (await fetch(`http://127.0.0.1:${port}/teamclaude/certs/ensure`, { method: 'POST', headers: { 'x-api-key': 'k' } })).json()).caPath;
      assert.equal(p1, p2);
    } finally { proxy.close(); }
  });
});

test('certs/ensure requires the key even from loopback (mutation)', async () => {
  await withCertDir(async () => {
    const proxy = createProxyServer(am(), { proxy: { apiKey: 'k' }, upstream: 'https://api.anthropic.com' }, {});
    const port = await listen(proxy);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/teamclaude/certs/ensure`, { method: 'POST' });
      assert.equal(res.status, 401);
    } finally { proxy.close(); }
  });
});
