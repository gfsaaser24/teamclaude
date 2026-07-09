import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

// Make an account read as over-threshold for every model (spent 5h bucket), so
// _isAvailable returns false — the same "can't serve this request" condition a
// real rate-limit/exhaustion produces.
function overThreshold(am, idx) {
  am.accounts[idx].quota.unified5h = 0.99; // >= 0.98 switch threshold
}

test('setManualAccount pins by name; getActiveAccount returns it even when another account is preferred', () => {
  // 'a' has the most-preferred priority, so auto-selection would normally pick it.
  const am = new AccountManager([oauth('a', { priority: -1 }), oauth('b'), oauth('c')], 0.98);
  assert.equal(am.setManualAccount('c'), 'c');
  assert.equal(am.getActiveAccount().name, 'c');
  assert.equal(am.getActiveAccount().name, 'c'); // stable across repeated requests
});

test('setManualAccount pins by numeric index too', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98);
  assert.equal(am.setManualAccount('1'), 'b');
  assert.equal(am.getActiveAccount().name, 'b');
});

test('a pinned account that is excluded this request falls through to another account', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98);
  am.setManualAccount('b'); // index 1
  const acct = am.getActiveAccount(new Set([1]));
  assert.ok(acct);
  assert.notEqual(acct.name, 'b'); // pin can't serve → auto-fallback keeps traffic flowing
});

test('a pinned account that is unavailable (over threshold) falls through to another account', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98);
  am.setManualAccount('b'); // index 1
  overThreshold(am, 1);
  const acct = am.getActiveAccount();
  assert.ok(acct);
  assert.notEqual(acct.name, 'b');
});

test('a pinned account that is throttled falls through, then is honored again once the hold clears', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98);
  am.setManualAccount('b'); // index 1
  am.accounts[1].status = 'throttled';
  am.accounts[1].rateLimitedUntil = Date.now() + 60_000;
  assert.notEqual(am.getActiveAccount().name, 'b'); // held → fall through

  // Hold expires → pin is honored again (pin is not cleared by a transient block).
  am.accounts[1].rateLimitedUntil = Date.now() - 1000;
  assert.equal(am.getActiveAccount().name, 'b');
});

test('clearManualAccount returns selection to full auto', () => {
  const am = new AccountManager([oauth('a', { priority: -1 }), oauth('b'), oauth('c')], 0.98);
  am.setManualAccount('c');
  assert.equal(am.getActiveAccount().name, 'c');
  am.clearManualAccount();
  // Auto-selection prefers 'a' (priority -1); the pin no longer overrides it.
  assert.equal(am.getActiveAccount().name, 'a');
});

test('getStatus().manualAccount reflects the pinned name and is null after clear', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  assert.equal(am.getStatus().manualAccount, null);
  am.setManualAccount('b');
  assert.equal(am.getStatus().manualAccount, 'b');
  am.clearManualAccount();
  assert.equal(am.getStatus().manualAccount, null);
});

test('setManualAccount with an out-of-range index or unknown name returns null and sets no pin', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  assert.equal(am.setManualAccount('9'), null);
  assert.equal(am.manualIndex, null);
  assert.equal(am.setManualAccount('nope'), null);
  assert.equal(am.manualIndex, null);
});

test('removeAccount fixes up the manual pin like currentIndex', () => {
  // Pin the last account, remove an earlier one → pin shifts down to still point at it.
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98);
  am.setManualAccount('c'); // index 2
  am.removeAccount(0);      // 'a' removed → 'c' is now index 1
  assert.equal(am.manualIndex, 1);
  assert.equal(am.getStatus().manualAccount, 'c');

  // Removing the pinned account itself clears the pin (back to auto).
  am.removeAccount(am.manualIndex);
  assert.equal(am.manualIndex, null);
  assert.equal(am.getStatus().manualAccount, null);
});
