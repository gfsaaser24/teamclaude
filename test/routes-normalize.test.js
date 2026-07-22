import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AccountManager,
  normalizeRoutesInput,
  sanitizeRouteAccounts,
  migrateCorruptRoutes,
} from '../src/account-manager.js';
import { accountStableId } from '../src/identity.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

// ── sanitizeRouteAccounts (item 6 hygiene) ───────────────────────────────────

test('sanitizeRouteAccounts drops object entries and "[object Object]" residue', () => {
  assert.deepEqual(
    sanitizeRouteAccounts(['alpha', { name: 'beta', eligible: true }, '[object Object]', '', 'beta']),
    ['alpha', 'beta'],
  );
});

test('sanitizeRouteAccounts stringifies legacy numeric index refs', () => {
  assert.deepEqual(sanitizeRouteAccounts(['a', 2]), ['a', '2']);
});

test('sanitizeRouteAccounts tolerates non-array input', () => {
  assert.deepEqual(sanitizeRouteAccounts(undefined), []);
  assert.deepEqual(sanitizeRouteAccounts(null), []);
});

test('setRoutes filters corrupt account entries as defense-in-depth', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  am.setRoutes([{ name: 'r', match: ['*fable*'], accounts: ['a', { name: 'b', eligible: false }, '[object Object]'] }]);
  assert.deepEqual(am.routes[0].accounts, ['a']);
  // A corrupt route can no longer silently bar every account: 'a' still eligible.
  assert.equal(am._isAvailable(am.accounts[0], 'claude-fable-5'), true);
});

// ── normalizeRoutesInput (POST /teamclaude/routes validation) ────────────────

test('normalizeRoutesInput accepts names + stable ids and defaults name/match', () => {
  const am = new AccountManager([oauth('a', { accountUuid: 'u1', orgUuid: 'o1' })], 0.98);
  const out = normalizeRoutesInput([{ match: '*fable*', accounts: ['a'] }], am.accounts);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'route-1');            // defaulted
  assert.deepEqual(out[0].match, ['*fable*']);      // wrapped to array
  // A known name ref is normalized to the account's stable id.
  assert.deepEqual(out[0].accounts, ['u1::o1']);
});

test('normalizeRoutesInput keeps an unknown ref verbatim (account may be added later)', () => {
  const out = normalizeRoutesInput([{ match: ['*x*'], accounts: ['ghost'] }], []);
  assert.deepEqual(out[0].accounts, ['ghost']);
});

test('normalizeRoutesInput rejects object account references', () => {
  assert.throws(
    () => normalizeRoutesInput([{ match: '*x*', accounts: [{ name: 'a' }] }], []),
    /objects\/indices rejected/,
  );
});

test('normalizeRoutesInput rejects numeric index references', () => {
  assert.throws(() => normalizeRoutesInput([{ match: '*x*', accounts: ['0'] }], []), /numeric index/);
  assert.throws(() => normalizeRoutesInput([{ match: '*x*', accounts: [1] }], []), /must be a string/);
});

test('normalizeRoutesInput rejects a non-array payload and empty match', () => {
  assert.throws(() => normalizeRoutesInput('nope', []), /must be an array/);
  assert.throws(() => normalizeRoutesInput([{ accounts: ['a'] }], []), /at least one string match/);
  assert.throws(() => normalizeRoutesInput([{ match: [] }], []), /at least one string match/);
});

test('normalizeRoutesInput carries a string bucket and rejects a non-string one', () => {
  const out = normalizeRoutesInput([{ match: '*x*', bucket: 'unified7dFable' }], []);
  assert.equal(out[0].bucket, 'unified7dFable');
  assert.ok(!('accounts' in out[0]));               // omitted when empty
  assert.throws(() => normalizeRoutesInput([{ match: '*x*', bucket: 5 }], []), /bucket must be a string/);
});

// ── exportRoutes (GET /teamclaude/routes shape) ──────────────────────────────

test('exportRoutes returns editable routes without autocreated/eligibility view', () => {
  const am = new AccountManager([oauth('a')], 0.98, {
    routes: [{ name: 'fable', match: ['*fable*'], accounts: ['a'], bucket: 'unified7dFable' }],
  });
  assert.deepEqual(am.exportRoutes(), [
    { name: 'fable', match: ['*fable*'], accounts: ['a'], bucket: 'unified7dFable' },
  ]);
});

// ── migrateCorruptRoutes (one-time config cleanup) ───────────────────────────

test('migrateCorruptRoutes sanitizes object/[object Object] entries and reports change', () => {
  const config = { routes: [
    { name: 'bad', match: ['*fable*'], accounts: ['a', { name: 'b' }, '[object Object]'] },
    { name: 'ok', match: ['*opus*'], accounts: ['a'] },
  ] };
  assert.equal(migrateCorruptRoutes(config), true);
  assert.deepEqual(config.routes[0].accounts, ['a']);
  assert.deepEqual(config.routes[1].accounts, ['a']); // untouched
});

test('migrateCorruptRoutes is a no-op on a clean config (incl. legacy numeric index)', () => {
  const config = { routes: [{ name: 'r', match: ['*x*'], accounts: [1, 'a'] }] };
  assert.equal(migrateCorruptRoutes(config), false);
  assert.deepEqual(config.routes[0].accounts, [1, 'a']); // left verbatim
});

test('migrateCorruptRoutes drops a non-array accounts field', () => {
  const config = { routes: [{ name: 'r', match: ['*x*'], accounts: 'a' }] };
  assert.equal(migrateCorruptRoutes(config), true);
  assert.ok(!('accounts' in config.routes[0]));
});

test('migrateCorruptRoutes tolerates a missing/invalid routes array', () => {
  assert.equal(migrateCorruptRoutes({}), false);
  assert.equal(migrateCorruptRoutes({ routes: null }), false);
});

// ── runtime route matching by stable id ──────────────────────────────────────

test('a route pinned by stable id restricts eligibility to that account', () => {
  const am = new AccountManager([
    oauth('a', { accountUuid: 'u1', orgUuid: 'o1' }),
    oauth('b', { accountUuid: 'u2', orgUuid: 'o2' }),
  ], 0.98);
  am.setRoutes([{ name: 'fable', match: ['*fable*'], accounts: [accountStableId(am.accounts[0])] }]);
  assert.equal(am._isAvailable(am.accounts[0], 'claude-fable-5'), true);
  assert.equal(am._isAvailable(am.accounts[1], 'claude-fable-5'), false);
});
