import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

test('updateQuota stamps observedAt for the buckets it learns from a live response', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const before = Date.now();
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-5h-utilization': '0.4',
    'anthropic-ratelimit-unified-7d-utilization': '0.6',
    'anthropic-ratelimit-unified-7d_oi-utilization': '0.2',
  });
  const oa = am.accounts[0].observedAt;
  assert.ok(oa.unified5h >= before, 'unified5h stamped');
  assert.ok(oa.unified7d >= before, 'unified7d stamped');
  assert.ok(oa.unified7dFable >= before, 'fable weekly stamped');
  // A bucket not present in the headers was never observed.
  assert.equal(oa.unified7dSonnet, undefined);
});

test('updateQuota stamps the standard bucket for API-key token/request limits', () => {
  const am = new AccountManager([{ name: 'k', type: 'apikey', apiKey: 'x' }], 0.98);
  am.updateQuota(0, {
    'anthropic-ratelimit-tokens-limit': '1000',
    'anthropic-ratelimit-tokens-remaining': '900',
  });
  assert.ok(am.accounts[0].observedAt.standard > 0);
});

test('applyUsageData (probe) stamps observedAt like a real response', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const before = Date.now();
  am.applyUsageData(0, { sevenDayFable: { utilization: 0.5, resetAt: Date.now() + 1000 } });
  assert.ok(am.accounts[0].observedAt.unified7dFable >= before);
});

test('getStatus exposes stable id, email, and per-bucket observedAt (ISO)', () => {
  const am = new AccountManager([oauth('user@x.com (Acme)', { accountUuid: 'u1', orgUuid: 'o1' })], 0.98);
  am.updateQuota(0, { 'anthropic-ratelimit-unified-5h-utilization': '0.3' });
  const [acct] = am.getStatus().accounts;
  assert.equal(acct.id, 'u1::o1');
  assert.equal(acct.email, 'user@x.com');            // org suffix stripped
  assert.match(acct.observedAt.unified5h, /^\d{4}-\d{2}-\d{2}T/); // ISO timestamp
});

test('getStatus id falls back to a name-scoped id for API-key accounts', () => {
  const am = new AccountManager([{ name: 'glm', type: 'apikey', apiKey: 'x' }], 0.98);
  assert.equal(am.getStatus().accounts[0].id, 'name:glm');
});

test('observedAt survives an export → restore round-trip (freshness is not reset)', () => {
  const am1 = new AccountManager([oauth('a', { accountUuid: 'u1', orgUuid: 'o1' })], 0.98);
  const stamp = Date.now() - 10 * 60_000; // observed 10 minutes ago
  am1.accounts[0].quota.unified7d = 0.5;
  am1.accounts[0].observedAt.unified7d = stamp;

  const am2 = new AccountManager([oauth('a', { accountUuid: 'u1', orgUuid: 'o1' })], 0.98);
  am2.restoreQuotaState(am1.exportQuotaState());
  assert.equal(am2.accounts[0].observedAt.unified7d, stamp); // original time, not "now"
});
