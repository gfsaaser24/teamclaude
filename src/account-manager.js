import { refreshAccessToken, isTokenExpiringSoon, isTokenExpired } from './oauth.js';
import { sameIdentity, accountStableId, emailOf } from './identity.js';
import { weeklyBucketForModel, modelGlobMatches } from './model.js';

// Bucket keys stamped with an `observedAt` time when their utilization is
// refreshed from a real upstream response or probe. The 5h/weekly unified
// buckets plus a single `standard` slot for API-key token/request limits.
const OBSERVED_BUCKETS = ['unified5h', 'unified7d', 'unified7dSonnet', 'unified7dFable', 'standard'];

// Re-exported for callers that already import model helpers from here.
export { isFableModel, modelFamily, parseRequestModel, weeklyBucketForModel, modelGlobMatches } from './model.js';

// Quota fields that survive a restart: utilization levels and their reset
// windows, learned passively from upstream responses. Transient/derived state
// (probing, requalify, rateLimitedUntil) is intentionally excluded.
const PERSISTED_QUOTA_FIELDS = [
  'unified5h', 'unified7d', 'unified7dSonnet', 'unified7dFable',
  'unified5hReset', 'unified7dReset', 'unified7dSonnetReset', 'unified7dFableReset', 'unifiedStatus',
  'tokensLimit', 'tokensRemaining', 'requestsLimit', 'requestsRemaining', 'resetsAt',
];

function emptyQuota() {
  return {
    // Standard API rate limits (API key accounts)
    tokensLimit: null,
    tokensRemaining: null,
    requestsLimit: null,
    requestsRemaining: null,
    // Unified rate limits (Claude Max accounts)
    unified5h: null,            // utilization 0-1
    unified7d: null,            // utilization 0-1
    unified7dSonnet: null,      // utilization 0-1 (Sonnet-specific weekly bucket)
    unified7dFable: null,       // utilization 0-1 (Fable-specific weekly bucket)
    unified5hReset: null,       // ms timestamp
    unified7dReset: null,       // ms timestamp
    unified7dSonnetReset: null, // ms timestamp
    unified7dFableReset: null,  // ms timestamp
    unifiedStatus: null,        // allowed | allowed_warning | rejected
    resetsAt: null,
  };
}

// Does a declared `models` entry name `model`? The declared side may carry a
// trailing [Nm] context-length suffix (e.g. "deepseek-v4-pro[1m]"); we match it
// against a bare request too. Shared by _accountOwnsModel's two lookups so the
// predicate can't drift.
function modelMatches(declared, model) {
  return declared === model || declared.replace(/\[\d+m\]$/, '') === model;
}

/**
 * Defense-in-depth sanitizer for a route's `accounts` list (item 6 hygiene):
 * drop anything that isn't a usable string/number reference. The desktop
 * Routing.tsx corruption wrote `{name, eligible}` objects here, which
 * `String()` turned into the useless literal "[object Object]" — filter both
 * the raw objects and any residual "[object Object]" strings left on disk.
 * Numeric index refs are preserved (stringified) for backward compatibility.
 */
export function sanitizeRouteAccounts(accounts) {
  if (!Array.isArray(accounts)) return [];
  const out = [];
  for (const a of accounts) {
    if (typeof a === 'number' && Number.isFinite(a)) { out.push(String(a)); continue; }
    if (typeof a !== 'string') continue;            // drop objects/null (the corruption)
    const s = a.trim();
    if (!s || s === '[object Object]') continue;    // drop empty + stringified-object residue
    out.push(s);
  }
  return out;
}

/**
 * One-time cleanup migration (item 6): the desktop Routing.tsx bug wrote
 * `{name,eligible}` objects (which `String()` turned into "[object Object]")
 * into `route.accounts`, silently barring every account from the routed model.
 * Sanitize only genuinely-corrupt entries so a valid numeric-index config isn't
 * needlessly rewritten. Mutates `config.routes` in place; returns true if it
 * changed anything so the caller persists once.
 */
export function migrateCorruptRoutes(config) {
  if (!config || !Array.isArray(config.routes)) return false;
  const isCorrupt = a => (typeof a !== 'string' && typeof a !== 'number') || a === '[object Object]';
  let changed = false;
  for (const r of config.routes) {
    if (!r || typeof r !== 'object') continue;
    if (!('accounts' in r)) continue;
    if (!Array.isArray(r.accounts)) { delete r.accounts; changed = true; continue; }
    if (!r.accounts.some(isCorrupt)) continue; // no corruption → leave verbatim
    const clean = sanitizeRouteAccounts(r.accounts);
    if (clean.length) r.accounts = clean; else delete r.accounts;
    changed = true;
  }
  return changed;
}

/**
 * Validate + normalize a routes payload from POST /teamclaude/routes. Throws on
 * any malformed input (the endpoint maps that to 400). Account references must
 * be strings — a stable id (item 5b) or a plain-string account name (accepted
 * during the id-migration deprecation window). Objects are always rejected and
 * numeric indices are rejected (they shift after a removal). Known name refs are
 * normalized to the stable id so the persisted config converges on stable ids.
 */
export function normalizeRoutesInput(routes, accounts = []) {
  if (!Array.isArray(routes)) throw new Error('routes must be an array');
  return routes.map((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error(`route[${i}] must be an object`);
    const rawMatch = Array.isArray(r.match) ? r.match : (r.match != null ? [r.match] : []);
    const match = rawMatch.filter(g => typeof g === 'string' && g.trim()).map(g => g.trim());
    if (!match.length) throw new Error(`route[${i}] needs at least one string match glob`);

    const rawAccounts = r.accounts == null ? [] : r.accounts;
    if (!Array.isArray(rawAccounts)) throw new Error(`route[${i}].accounts must be an array`);
    const accts = rawAccounts.map((a, j) => {
      if (typeof a !== 'string') {
        throw new Error(`route[${i}].accounts[${j}] must be a string account id or name (objects/indices rejected)`);
      }
      const s = a.trim();
      if (!s) throw new Error(`route[${i}].accounts[${j}] must be a non-empty string`);
      if (/^\d+$/.test(s)) throw new Error(`route[${i}].accounts[${j}] is a numeric index; use a stable account id or name`);
      // Normalize a known name ref to its stable id; leave unknown refs verbatim
      // (the account may be added after the route is defined).
      const acct = accounts.find(ac => ac.name === s || accountStableId(ac) === s);
      return acct ? accountStableId(acct) : s;
    });

    const out = { name: (typeof r.name === 'string' && r.name.trim()) ? r.name.trim() : `route-${i + 1}`, match };
    if (accts.length) out.accounts = accts;
    if (r.bucket != null) {
      if (typeof r.bucket !== 'string') throw new Error(`route[${i}].bucket must be a string`);
      if (r.bucket.trim()) out.bucket = r.bucket.trim();
    }
    return out;
  });
}

export class AccountManager {
  constructor(accounts, switchThreshold = 0.98, { refreshFn = refreshAccessToken, throttleProbeFloorMs, routes } = {}) {
    // Injectable for tests (mirrors Prober's probeFn); defaults to the real
    // OAuth token refresh.
    this._refreshFn = refreshFn;
    this.accounts = accounts.map((acct, index) => ({
      index,
      name: acct.name,
      type: acct.type,
      accountUuid: acct.accountUuid || null,
      orgUuid: acct.orgUuid || null,
      orgName: acct.orgName || null,
      priority: acct.priority || 0,
      disabled: acct.disabled || false,
      upstream: acct.upstream || null,
      modelMap: acct.modelMap || null,
      models: acct.models || null,
      credential: acct.accessToken || acct.apiKey,
      refreshToken: acct.refreshToken || null,
      expiresAt: acct.expiresAt || null,
      status: 'active',
      // No quota is known at startup, so start probing: the first response for
      // an account reveals its weekly limit and triggers re-evaluation.
      probing: true,
      quota: emptyQuota(),
      // Per-bucket wall-clock time (ms) each quota field was last learned from a
      // real upstream response/probe. NOT the HTTP receipt time — restored quota
      // keeps its original observedAt so a stale value reads as stale (item 8).
      observedAt: {},
      usage: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalRequests: 0,
        lastUsed: null,
      },
      rateLimitedUntil: null,
      throttledAt: null,
    }));
    this.currentIndex = 0;
    // Runtime-only manual pin (resets on restart): index of the account the user
    // hand-picked as active, or null for full auto-rotation. See getActiveAccount.
    this.manualIndex = null;
    this.switchThreshold = switchThreshold;
    this.setRoutes(routes);
    // When every account reads as over-quota we would otherwise refuse locally
    // forever (a stale cached utilization is never re-validated because no
    // request is ever sent). Instead, allow one real upstream probe at most this
    // often to refresh the cached quota. See _selectProbe.
    this.probeIntervalMs = 60_000;
    this._nextProbeAt = 0;
    // Minimum time a 429 hold is respected verbatim before a throttled account
    // becomes probe-eligible (see _isProbeable). Long enough to honor a genuine
    // retry-after, short enough that a stale hold cannot pin the fleet.
    this.throttleProbeFloorMs = throttleProbeFloorMs
      ?? (Number(process.env.TEAMCLAUDE_THROTTLE_PROBE_FLOOR_MS) || 60_000);
  }

  /**
   * Get the best available account, rotating if the current one is near quota.
   * Returns null if all accounts are exhausted.
   */
  getActiveAccount(exclude = null, model = null) {
    // Clear expired quotas across all accounts and switch proactively if a
    // session reset made a sooner-expiring account the better choice. This runs
    // on every request so the behaviour holds without the TUI render loop.
    this.refreshExpiredQuotas();
    // Manual pin: honor the user's hand-picked account whenever it can serve this
    // request; fall through to auto-selection only when it's unavailable
    // (rate-limited/exhausted for this model) or already tried this request.
    if (this.manualIndex != null) {
      const pinned = this.accounts[this.manualIndex];
      if (pinned && this._isAvailable(pinned, model) && !exclude?.has(pinned.index)) {
        this.currentIndex = this.manualIndex;
        return pinned;
      }
    }
    const current = this.accounts[this.currentIndex];
    // `model` scopes availability: an account whose Fable weekly bucket is spent
    // is still fully usable for other models, so it is only excluded when THIS
    // request targets Fable (see _isAvailable).
    // `exclude` is a per-request set of indices already tried this request (e.g.
    // an account that just threw a transport error). It is never a persistent
    // status change — the account stays healthy for the next request.
    // We just learned a probed account's weekly quota — re-evaluate which
    // account is best now that its limit is known.
    if (current && current.requalify) {
      current.requalify = false;
      const next = this._selectNext(exclude, model);
      if (next) return next;
    }
    if (this._isAvailable(current, model) && !exclude?.has(current.index)) {
      // A strictly higher-priority (lower value) available account preempts a
      // healthy current one. Within the same priority tier we stay put, so the
      // common case (all accounts at the default priority 0) is unchanged and
      // never thrashes — preemption only triggers when priorities differ.
      const betterExists = this.accounts.some(a =>
        this._isAvailable(a, model) && !exclude?.has(a.index) && (a.priority || 0) < (current.priority || 0));
      return betterExists ? this._selectNext(exclude, model) : current;
    }
    const next = this._selectNext(exclude, model);
    if (next) return next;
    // No account is under the switch threshold. Before refusing locally, allow a
    // throttled probe so a stale/poisoned cached quota can't pin us in a
    // permanent "all exhausted" state — the probe's real response refreshes the
    // quota (or upstream's own 429 converts soft exhaustion into a hard
    // rate-limit hold). null here means the caller emits the synthetic 429.
    return this._selectProbe(exclude, model);
  }

  /**
   * Like getActiveAccount, but if the selected account's OAuth token has ALREADY
   * expired it blocks on a refresh before returning — so a caller that injects
   * the token immediately (the MITM relay) never sends a dead token and eats a
   * 401. A token that is merely expiring soon (still valid) is left to the
   * caller's opportunistic background refresh; only a hard-expired one blocks.
   */
  async getActiveAccountFresh(exclude = null, model = null) {
    const account = this.getActiveAccount(exclude, model);
    if (account && account.type === 'oauth' && account.refreshToken
        && isTokenExpired(account.expiresAt)) {
      await this.ensureTokenFresh(account.index); // coalesces with any in-flight refresh
    }
    return account;
  }

  /** Pin the active account by name or numeric index. Returns the pinned account name, or null if not found. */
  setManualAccount(token) {
    let idx = this.accounts.findIndex(a => a.name === token);
    if (idx < 0 && /^\d+$/.test(String(token))) {
      const n = Number(token);
      if (n >= 0 && n < this.accounts.length) idx = n;
    }
    if (idx < 0) return null;
    this.manualIndex = idx;
    this.currentIndex = idx;
    return this.accounts[idx].name;
  }

  clearManualAccount() { this.manualIndex = null; }

  _isProbeable(account) {
    if (!account) return false;
    // Never probe an account the operator has taken out of rotation or one
    // whose token is broken — those are hard states, not stale guesses.
    if (account.disabled) return false;
    if (account.status === 'error' || account.status === 'exhausted') return false;
    // A 429 hold is respected verbatim at first, but a hold is a snapshot: the
    // 429 that armed it may itself have been transient (e.g. the retry burst
    // after a network flap), and while it lasts NOTHING revalidates it — so a
    // stale hold pins the fleet in synthetic 429s for up to an hour and only a
    // restart (which wipes the in-memory hold) recovers. After the floor, let
    // the account be probed: the probe's real response either clears the hold
    // (any non-429 → clearRateLimited) or re-arms it with a fresh retry-after.
    if (account.status === 'throttled' && account.rateLimitedUntil
        && Date.now() < account.rateLimitedUntil) {
      return Date.now() >= (account.throttledAt || 0) + this.throttleProbeFloorMs;
    }
    return true;
  }

  /** Highest utilization across the quota dimensions that govern `model` (0-1),
   * used to pick the least-exhausted probe target. Mirrors _isNearQuota: the
   * shared 5-hour bucket plus the model's governing weekly bucket. With no model
   * it falls back to the shared weekly. */
  _maxUtilization(account, model = null) {
    const q = account.quota;
    let max = 0;
    if (q.unified5h != null) max = Math.max(max, q.unified5h);
    const weeklyVal = this._governingWeekly(account, model);
    if (weeklyVal != null) max = Math.max(max, weeklyVal);
    if (q.tokensLimit != null && q.tokensRemaining != null) {
      max = Math.max(max, 1 - q.tokensRemaining / q.tokensLimit);
    }
    if (q.requestsLimit != null && q.requestsRemaining != null) {
      max = Math.max(max, 1 - q.requestsRemaining / q.requestsLimit);
    }
    return max;
  }

  /** Utilization (0-1) of the weekly bucket that governs `model` on this account:
   * unified7dFable for Fable, unified7dSonnet for Sonnet, unified7d otherwise.
   * Falls back to the shared unified7d when a family-specific bucket isn't
   * reported. Returns null when nothing is known. */
  _governingWeekly(account, model) {
    const q = account.quota;
    const key = this._weeklyBucketFor(model);
    if (q[key] != null) return q[key];
    return key !== 'unified7d' ? q.unified7d : null;
  }

  /** Reset timestamp (ms) of the weekly bucket that governs `model`, falling back
   * to the shared weekly reset. Used to spend the soonest-expiring quota first. */
  _governingWeeklyReset(account, model) {
    const q = account.quota;
    const key = this._weeklyBucketFor(model);
    return q[`${key}Reset`] || q.unified7dReset || null;
  }

  /** True when the family-specific weekly bucket that governs `model` is spent.
   * Unlike _isNearQuota this ignores the shared 5h/weekly caps — it is only used
   * to skip an account for a probe of a model it definitely can't serve. Returns
   * false for families without a dedicated bucket (they share unified7d, already
   * covered by _isNearQuota). */
  _modelWeeklyExhausted(account, model) {
    const q = account.quota;
    const key = this._weeklyBucketFor(model);
    if (key === 'unified7d') return false;
    return q[key] != null && q[key] >= this.switchThreshold;
  }

  /**
   * Pick an account to send a single revalidation probe upstream when every
   * account reads as over the switch threshold. Throttled to one probe per
   * probeIntervalMs so a genuinely-exhausted fleet isn't hammered — between
   * probes this returns null and the caller falls back to the synthetic 429.
   * The chosen account is the least-utilized probeable one (most likely to have
   * stale headroom), so the refreshed quota corrects the cache fastest.
   */
  _selectProbe(exclude = null, model = null) {
    const now = Date.now();
    if (now < this._nextProbeAt) return null;

    let best = null;
    let bestPriority = Infinity;
    let bestUsage = Infinity;
    for (const account of this.accounts) {
      if (exclude?.has(account.index)) continue;
      if (!this._isProbeable(account)) continue;
      // A family-exhausted account can't serve that family even as a probe — it
      // would just 429 again — so skip it (Fable/Sonnet) and let the caller emit
      // the synthetic 429 when no other account is available.
      if (model && this._modelWeeklyExhausted(account, model)) continue;
      // Same for routing/ownership: a probe for a routed or owned model must not
      // land on an ineligible account (it would just reject the unknown model id).
      if (model && !this._routeAllows(account, model)) continue;
      const priority = account.priority || 0;
      const usage = this._maxUtilization(account, model);
      if (priority < bestPriority ||
          (priority === bestPriority && usage < bestUsage)) {
        bestPriority = priority;
        bestUsage = usage;
        best = account;
      }
    }
    if (!best) return null;

    this._nextProbeAt = now + this.probeIntervalMs;
    this.currentIndex = best.index;
    if (best.status === 'throttled') {
      console.log(`[TeamClaude] All accounts unavailable — revalidating throttled "${best.name}" with a live request`);
    } else {
      console.log(`[TeamClaude] All accounts over threshold — probing "${best.name}" to refresh quota`);
    }
    return best;
  }

  _isAvailable(account, model = null) {
    if (!account) return false;

    // Manually disabled accounts are skipped entirely until re-enabled.
    if (account.disabled) return false;

    // Check rate limit expiry
    if (account.status === 'throttled' && account.rateLimitedUntil) {
      if (Date.now() < account.rateLimitedUntil) return false;
      account.status = 'active';
      account.rateLimitedUntil = null;
      account.throttledAt = null;
      console.log(`[TeamClaude] Account "${account.name}" rate limit expired, marking active`);
    }

    if (account.status === 'exhausted' || account.status === 'error') return false;
    // Model-scoped: _isNearQuota checks the shared 5h bucket plus only the weekly
    // bucket that governs this model, so a spent Fable/Sonnet bucket bars just
    // that family — the account still serves every other model normally.
    if (this._isNearQuota(account, model)) return false;

    // Route/ownership restriction: a configured route can pin a model pattern to
    // an exclusive set of accounts; failing that, a per-account `models` claim
    // restricts an owned model to its owners. Either way an account not eligible
    // for this model is skipped so the request never lands somewhere it can't run.
    if (model && !this._routeAllows(account, model)) return false;

    return true;
  }

  /**
   * Normalize and store the configurable routing table. A route pins a set of
   * model globs to an exclusive set of accounts (and may override the governing
   * quota bucket). Called from the constructor and on config reload.
   *   { name, match: string|string[], accounts?: (name|index)[], bucket? }
   */
  setRoutes(routes) {
    this.routes = (Array.isArray(routes) ? routes : []).map((r, i) => ({
      name: r.name || `route-${i + 1}`,
      match: (Array.isArray(r.match) ? r.match : [r.match]).filter(g => typeof g === 'string' && g),
      // Hygiene (item 6): drop the {name,eligible} object entries / "[object
      // Object]" residue that the desktop Routing.tsx bug wrote here, so a
      // corrupt route can never silently bar every account from a model.
      accounts: sanitizeRouteAccounts(r.accounts),
      bucket: r.bucket || null,
    })).filter(r => r.match.length);
  }

  /** True if a route account *reference* names this account: a stable id, a
   * plain-string name (deprecation window), or a legacy numeric index. */
  _accountMatchesRef(account, ref) {
    if (typeof ref !== 'string') return false;
    return ref === account.name
      || ref === accountStableId(account)
      || ref === String(account.index);
  }

  /** The persisted, editable route table (what GET /teamclaude/routes returns) —
   * the normalized configured routes only, without the display view's
   * auto-created routes or eligibility flags. */
  exportRoutes() {
    return this.routes.map(r => {
      const out = { name: r.name, match: [...r.match] };
      if (r.accounts.length) out.accounts = [...r.accounts];
      if (r.bucket) out.bucket = r.bucket;
      return out;
    });
  }

  /** The first configured route whose globs match `model`, or null. */
  _routeForModel(model) {
    if (!model || !this.routes?.length) return null;
    return this.routes.find(r => r.match.some(g => modelGlobMatches(g, model))) || null;
  }

  /** The weekly quota bucket that governs `model` — a matching route's `bucket`
   * override wins, otherwise the model family's default bucket. */
  _weeklyBucketFor(model) {
    const route = this._routeForModel(model);
    return route?.bucket || weeklyBucketForModel(model);
  }

  /** Whether `account` may serve `model`. A matching route with an `accounts`
   * list is exclusive (only listed accounts, by name or index). With no matching
   * route — or a route that lists no accounts — it falls back to the per-account
   * `models` ownership claim so PR #74 configs keep working. */
  _routeAllows(account, model) {
    const route = this._routeForModel(model);
    if (route && route.accounts.length) {
      return route.accounts.some(ref => this._accountMatchesRef(account, ref));
    }
    return this._accountOwnsModel(account, model);
  }

  /** Returns true if no account claims model ownership, or this account does. */
  _accountOwnsModel(account, model) {
    for (const a of this.accounts) {
      if (a.models && a.models.some(m => modelMatches(m, model))) {
        // Some other account owns this model — this account must own it too.
        return !!(account.models && account.models.some(m => modelMatches(m, model)));
      }
    }
    return true; // no one claims ownership → any account is fine
  }

  /**
   * The routing table for display: every configured route plus an ephemeral,
   * auto-created route for each model family that some account meters with its
   * own weekly bucket but no configured route already covers. Auto-created routes
   * carry `autocreated: true` and are never persisted — they simply surface the
   * per-model quota the server already respects. Each route lists the accounts it
   * can use with a live eligibility flag.
   */
  getRoutes() {
    const out = this.routes.map(r => ({
      name: r.name, match: r.match, bucket: r.bucket, autocreated: false,
      accounts: this._routeAccountsView(r),
    }));

    const detected = [];
    if (this.accounts.some(a => a.quota.unified7dFable != null)) {
      detected.push({ name: 'fable', match: ['*fable*'], sample: 'claude-fable-5' });
    }
    if (this.accounts.some(a => a.quota.unified7dSonnet != null)) {
      detected.push({ name: 'sonnet', match: ['*sonnet*'], sample: 'claude-sonnet-4-6' });
    }
    for (const d of detected) {
      if (this._routeForModel(d.sample)) continue; // already covered by a configured route
      out.push({
        name: d.name, match: d.match, bucket: null, autocreated: true,
        accounts: this.accounts.map(a => ({ name: a.name, eligible: this._isAvailable(a, d.sample) })),
      });
    }
    return out;
  }

  /** Accounts a configured route can use (all accounts when it lists none), each
   * with a live eligibility flag for a representative model of the route. */
  _routeAccountsView(route) {
    const sample = route.match[0].replace(/\*/g, '') || 'model';
    const inRoute = a => !route.accounts.length
      || route.accounts.some(ref => this._accountMatchesRef(a, ref));
    return this.accounts.filter(inRoute).map(a => ({ name: a.name, eligible: this._isAvailable(a, sample) }));
  }

  /**
   * Clear any quota counters whose reset time has passed. Cheap and safe to
   * call frequently (e.g. from the TUI render loop) — once a counter is cleared
   * it stays null until the next upstream response repopulates it, so the
   * "reset" log fires at most once per window.
   * @returns {{changed: boolean, session: boolean}} what was cleared.
   */
  _clearExpiredQuotas(account) {
    const q = account.quota;
    const now = Date.now();
    let changed = false;
    let session = false;

    // Clear expired unified quotas
    if (q.unified5h != null && q.unified5hReset && now >= q.unified5hReset) {
      console.log(`[TeamClaude] Account "${account.name}" session quota reset`);
      q.unified5h = null;
      q.unified5hReset = null;
      changed = true;
      session = true;
    }
    if (q.unified7d != null && q.unified7dReset && now >= q.unified7dReset) {
      console.log(`[TeamClaude] Account "${account.name}" weekly quota reset`);
      q.unified7d = null;
      q.unified7dReset = null;
      q.unifiedStatus = null;
      changed = true;
    }
    if (q.unified7dSonnet != null && q.unified7dSonnetReset && now >= q.unified7dSonnetReset) {
      q.unified7dSonnet = null;
      q.unified7dSonnetReset = null;
      changed = true;
    }
    if (q.unified7dFable != null && q.unified7dFableReset && now >= q.unified7dFableReset) {
      q.unified7dFable = null;
      q.unified7dFableReset = null;
      changed = true;
    }

    // Clear expired standard quotas
    if (q.resetsAt && now >= new Date(q.resetsAt).getTime()) {
      q.tokensRemaining = null;
      q.tokensLimit = null;
      q.requestsRemaining = null;
      q.requestsLimit = null;
      q.resetsAt = null;
      changed = true;
    }

    return { changed, session };
  }

  /**
   * Clear expired quotas across all accounts. Called from the display loop and
   * the request path so a window expiry (e.g. the 5-hour session quota) resets
   * the view instantly rather than waiting for the next request.
   *
   * When an account's session quota resets, it may have become the better
   * choice — switch to it if its weekly limit expires sooner than the current
   * account's (and it still has weekly quota), so we spend the quota closest to
   * refreshing first.
   */
  refreshExpiredQuotas() {
    let changed = false;
    const sessionReset = [];
    for (const account of this.accounts) {
      const r = this._clearExpiredQuotas(account);
      if (r.changed) changed = true;
      if (r.session) sessionReset.push(account);
    }
    if (sessionReset.length) this._switchOnSessionReset(sessionReset);
    return changed;
  }

  /**
   * Given accounts whose session quota just reset, switch to the one whose
   * weekly limit expires soonest — but only if that is sooner than the current
   * account's weekly limit and the account still has weekly quota to spend.
   */
  _switchOnSessionReset(candidates) {
    const current = this.accounts[this.currentIndex];
    // Need a known weekly reset on the current account to compare against;
    // if it is unknown we are still probing it, so leave it alone.
    if (!current || current.quota.unified7dReset == null) return;

    let best = null;
    let bestWeekly = current.quota.unified7dReset;
    for (const acc of candidates) {
      if (acc.index === this.currentIndex) continue;
      if (!this._isAvailable(acc)) continue; // enough session & weekly quota left
      // Don't demote to a lower-priority (higher value) account on a reset.
      if ((acc.priority || 0) > (current.priority || 0)) continue;
      const weekly = acc.quota.unified7dReset;
      if (weekly == null) continue; // need a known weekly to compare
      if (weekly < bestWeekly) {
        bestWeekly = weekly;
        best = acc;
      }
    }

    if (best) {
      this.currentIndex = best.index;
      console.log(`[TeamClaude] Account "${best.name}" session quota reset and weekly expires sooner — switching to it`);
    }
  }

  _isNearQuota(account, model = null) {
    const q = account.quota;
    this._clearExpiredQuotas(account);

    // Shared 5-hour bucket gates every request regardless of model.
    if (q.unified5h != null && q.unified5h >= this.switchThreshold) return true;

    // Only the weekly bucket that GOVERNS this model is checked: Fable and Sonnet
    // meter their own weekly quota, so a spent Fable bucket must not bar an Opus
    // or Sonnet request (and vice versa). When the family bucket isn't reported
    // (e.g. the plan doesn't expose it), fall back to the shared weekly so an
    // account over its overall cap is still treated as near-quota.
    const weeklyVal = this._governingWeekly(account, model);
    if (weeklyVal != null && weeklyVal >= this.switchThreshold) return true;

    // Standard quotas (API key accounts)
    if (q.tokensLimit != null && q.tokensRemaining != null) {
      const used = 1 - (q.tokensRemaining / q.tokensLimit);
      if (used >= this.switchThreshold) return true;
    }

    if (q.requestsLimit != null && q.requestsRemaining != null) {
      const used = 1 - (q.requestsRemaining / q.requestsLimit);
      if (used >= this.switchThreshold) return true;
    }

    return false;
  }

  /**
   * Pick the best available account by selection order, WITHOUT mutating state:
   *   1. lowest `priority` value (operator-controlled; default 0, lower = preferred)
   *   2. then the account with no known weekly limit — using it lets us
   *      discover its quota
   *   3. then the account whose weekly limit expires soonest: that quota is
   *      closest to refreshing, so spending it first preserves accounts whose
   *      weekly window resets further out.
   * With all priorities at the default 0, this reduces to the weekly-reset
   * heuristic. Returns the account or null if none are available.
   */
  _pickBestAvailable(exclude = null, model = null) {
    let best = null;
    let bestPriority = Infinity;
    let bestReset = Infinity;

    for (let i = 0; i < this.accounts.length; i++) {
      const account = this.accounts[i];
      if (exclude?.has(account.index)) continue;
      // _isAvailable filters out accounts at/above the switch threshold, so the
      // soonest-expiring pick only ever lands on an account whose 5-hour quota
      // is still below 98%.
      if (!this._isAvailable(account, model)) continue;

      const priority = account.priority || 0;
      // Rank by the reset of the weekly bucket that governs THIS model (Fable and
      // Sonnet have their own), so a Fable request spends the account whose Fable
      // window refreshes soonest while preserving accounts that reset later for
      // Opus/Sonnet. Unknown reset sorts first so we probe and fill it in.
      const weeklyReset = this._governingWeeklyReset(account, model) || -Infinity;
      if (priority < bestPriority ||
          (priority === bestPriority && weeklyReset < bestReset)) {
        bestPriority = priority;
        bestReset = weeklyReset;
        best = account;
      }
    }
    return best;
  }

  /**
   * Select the active account up front (e.g. on daemon launch, once persisted
   * quota has been restored) so we start on the highest-priority / soonest-
   * resetting account instead of blindly on index 0. Mirrors rotation order.
   * Returns the chosen account, or the existing current one if none are
   * available (the server still starts; requests 429 until a window resets).
   */
  selectActiveAccount() {
    this.refreshExpiredQuotas(); // drop any restored windows that already expired
    // Honor a manual pin so the reported active account matches per-request
    // routing (getActiveAccount honors it too). Fall through to auto-selection
    // only when the pinned account can't serve at all.
    if (this.manualIndex != null) {
      const pinned = this.accounts[this.manualIndex];
      if (pinned && this._isAvailable(pinned, null)) {
        this.currentIndex = this.manualIndex;
        return pinned;
      }
    }
    const best = this._pickBestAvailable();
    if (!best) return this.accounts[this.currentIndex] || null;
    this.currentIndex = best.index;
    best.probing = best.quota.unified7dReset == null;
    const wk = best.quota.unified7d != null
      ? `${(best.quota.unified7d * 100).toFixed(1)}% weekly used`
      : 'weekly quota unknown';
    console.log(`[TeamClaude] Starting on account "${best.name}" (priority ${best.priority || 0}, ${wk})`);
    return best;
  }

  _selectNext(exclude = null, model = null) {
    const best = this._pickBestAvailable(exclude, model);
    if (best) {
      const switched = best.index !== this.currentIndex;
      this.currentIndex = best.index;
      // If we switched to an account whose weekly quota is still unknown, flag
      // it so we re-evaluate once that quota is learned (see updateQuota).
      best.probing = best.quota.unified7dReset == null;
      if (switched) {
        console.log(`[TeamClaude] Switched to account "${best.name}"`);
      }
      return best;
    }

    // All accounts unavailable — find the one that resets soonest
    let soonestAccount = null;
    let soonestTime = Infinity;

    for (const account of this.accounts) {
      if (exclude?.has(account.index)) continue;
      // Never resurrect a hard-state account: `disabled` is an operator decision
      // and `error` means the token is broken (needs re-login). Selecting either
      // here would send a live request on an account that must not be used and,
      // below, silently clear its throttle/error state. (Mirrors _isAvailable.)
      if (account.disabled || account.status === 'error') continue;
      // A routed/owned model must not fall back to an ineligible account.
      if (model && !this._routeAllows(account, model)) continue;
      const resetTime = account.rateLimitedUntil
        || account.quota.unified5hReset
        || account.quota.unified7dReset
        || (account.quota.resetsAt ? new Date(account.quota.resetsAt).getTime() : null);

      if (resetTime && resetTime < soonestTime) {
        soonestTime = resetTime;
        soonestAccount = account;
      }
    }

    if (soonestAccount && soonestTime <= Date.now()) {
      soonestAccount.status = 'active';
      soonestAccount.rateLimitedUntil = null;
      this.currentIndex = soonestAccount.index;
      console.log(`[TeamClaude] Account "${soonestAccount.name}" reset, switching to it`);
      return soonestAccount;
    }

    return null;
  }

  /**
   * Update an account's quota tracking from upstream response headers.
   */
  updateQuota(accountIndex, headers) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    // Every field set below is learned from a live upstream response — stamp its
    // bucket's observedAt so freshness reflects real receipt, not a passive restore.
    const now = Date.now();

    // Unified rate limits (Claude Max)
    const u5h = parseFloat(headers['anthropic-ratelimit-unified-5h-utilization']);
    const u7d = parseFloat(headers['anthropic-ratelimit-unified-7d-utilization']);
    if (!isNaN(u5h)) { account.quota.unified5h = u5h; account.observedAt.unified5h = now; }
    if (!isNaN(u7d)) { account.quota.unified7d = u7d; account.observedAt.unified7d = now; }

    const r5h = headers['anthropic-ratelimit-unified-5h-reset'];
    const r7d = headers['anthropic-ratelimit-unified-7d-reset'];
    if (r5h) account.quota.unified5hReset = parseInt(r5h, 10) * 1000;
    if (r7d) account.quota.unified7dReset = parseInt(r7d, 10) * 1000;

    // Model-scoped weekly bucket — surfaced in headers as `7d_oi` ("7-day,
    // overage included"). On current subscription plans this is the Fable weekly
    // limit (it correlates with the usage endpoint's Fable-scoped weekly bucket).
    // Utilization here is already a 0-1 fraction (can exceed 1 when in overage).
    const u7dOi = parseFloat(headers['anthropic-ratelimit-unified-7d_oi-utilization']);
    if (!isNaN(u7dOi)) { account.quota.unified7dFable = u7dOi; account.observedAt.unified7dFable = now; }
    const r7dOi = headers['anthropic-ratelimit-unified-7d_oi-reset'];
    if (r7dOi) account.quota.unified7dFableReset = parseInt(r7dOi, 10) * 1000;

    // We switched to this account to discover its weekly quota; now that we
    // know it, flag for re-evaluation so selection can pick the best account.
    if (account.probing && account.quota.unified7dReset != null) {
      account.probing = false;
      account.requalify = true;
      console.log(`[TeamClaude] Learned weekly quota for "${account.name}", re-evaluating selection`);
    }

    const uStatus = headers['anthropic-ratelimit-unified-status'];
    if (uStatus) account.quota.unifiedStatus = uStatus;

    // Standard rate limits (API key accounts)
    const tokensLimit = parseInt(headers['anthropic-ratelimit-tokens-limit'], 10);
    const tokensRemaining = parseInt(headers['anthropic-ratelimit-tokens-remaining'], 10);
    const tokensReset = headers['anthropic-ratelimit-tokens-reset'];
    const requestsLimit = parseInt(headers['anthropic-ratelimit-requests-limit'], 10);
    const requestsRemaining = parseInt(headers['anthropic-ratelimit-requests-remaining'], 10);
    const requestsReset = headers['anthropic-ratelimit-requests-reset'];

    if (!isNaN(tokensLimit)) { account.quota.tokensLimit = tokensLimit; account.observedAt.standard = now; }
    if (!isNaN(tokensRemaining)) { account.quota.tokensRemaining = tokensRemaining; account.observedAt.standard = now; }
    if (!isNaN(requestsLimit)) { account.quota.requestsLimit = requestsLimit; account.observedAt.standard = now; }
    if (!isNaN(requestsRemaining)) { account.quota.requestsRemaining = requestsRemaining; account.observedAt.standard = now; }

    if (tokensReset) account.quota.resetsAt = tokensReset;
    else if (requestsReset) account.quota.resetsAt = requestsReset;

    account.usage.totalRequests++;
    account.usage.lastUsed = new Date().toISOString();

    // Log when approaching quota
    if (this._isNearQuota(account)) {
      const pct = account.quota.unified7d != null
        ? (account.quota.unified7d * 100).toFixed(1)
        : account.quota.tokensLimit
          ? ((1 - account.quota.tokensRemaining / account.quota.tokensLimit) * 100).toFixed(1)
          : '?';
      console.log(`[TeamClaude] Account "${account.name}" at ${pct}% usage — will switch on next request`);
    }
  }

  /**
   * Update cumulative token usage from response body data.
   */
  updateUsage(accountIndex, inputTokens, outputTokens) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    if (inputTokens) account.usage.totalInputTokens += inputTokens;
    if (outputTokens) account.usage.totalOutputTokens += outputTokens;
  }

  /**
   * Enable or disable an account. A disabled account is skipped by rotation
   * until re-enabled. Re-enabling also clears a stuck 'error' state (and any
   * lingering rate-limit hold) so the account is retried immediately.
   */
  setDisabled(accountIndex, disabled) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    account.disabled = disabled;
    if (!disabled && account.status === 'error') {
      account.status = 'active';
      account.rateLimitedUntil = null;
      console.log(`[TeamClaude] Account "${account.name}" re-enabled — clearing error state`);
    }
  }

  /**
   * Apply quota learned from the OAuth usage endpoint (the background probe).
   * Updates utilization/reset for the 5h, 7d, Sonnet-7d, and Fable-7d buckets WITHOUT
   * touching usage counters — a probe is not real client traffic.
   */
  applyUsageData(accountIndex, usage) {
    const account = this.accounts[accountIndex];
    if (!account || !usage) return;
    const q = account.quota;
    // A probe is a live read of the usage endpoint — stamp observedAt like a
    // real response so the cockpit's freshness reflects it (item 8).
    const now = Date.now();

    if (usage.fiveHour) {
      if (usage.fiveHour.utilization != null) { q.unified5h = usage.fiveHour.utilization; account.observedAt.unified5h = now; }
      if (usage.fiveHour.resetAt != null) q.unified5hReset = usage.fiveHour.resetAt;
    }
    if (usage.sevenDay) {
      if (usage.sevenDay.utilization != null) { q.unified7d = usage.sevenDay.utilization; account.observedAt.unified7d = now; }
      if (usage.sevenDay.resetAt != null) q.unified7dReset = usage.sevenDay.resetAt;
    }
    if (usage.sevenDaySonnet) {
      if (usage.sevenDaySonnet.utilization != null) { q.unified7dSonnet = usage.sevenDaySonnet.utilization; account.observedAt.unified7dSonnet = now; }
      if (usage.sevenDaySonnet.resetAt != null) q.unified7dSonnetReset = usage.sevenDaySonnet.resetAt;
    }
    if (usage.sevenDayFable) {
      if (usage.sevenDayFable.utilization != null) { q.unified7dFable = usage.sevenDayFable.utilization; account.observedAt.unified7dFable = now; }
      if (usage.sevenDayFable.resetAt != null) q.unified7dFableReset = usage.sevenDayFable.resetAt;
    }

    // If we just learned this account's weekly window while probing, re-evaluate
    // selection (same path as learning it from a live response).
    if (account.probing && q.unified7dReset != null) {
      account.probing = false;
      account.requalify = true;
    }
  }

  /**
   * Mark an account as rate-limited for a given duration.
   */
  markRateLimited(accountIndex, retryAfterSeconds) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    account.status = 'throttled';
    account.rateLimitedUntil = Date.now() + (retryAfterSeconds * 1000);
    // Marks when the hold was (re-)armed: a revalidation probe is allowed only
    // after throttleProbeFloorMs from here, so a probe that 429s again pushes
    // the next probe out by a full floor rather than hammering upstream.
    account.throttledAt = Date.now();
    console.log(`[TeamClaude] Account "${account.name}" rate limited for ${retryAfterSeconds}s`);
  }

  /**
   * Clear a rate-limit hold after live proof it no longer binds: any non-429
   * upstream response on a throttled account (a revalidation probe reaching
   * here, or a hold armed moments before traffic resumed). No-op otherwise.
   */
  clearRateLimited(accountIndex) {
    const account = this.accounts[accountIndex];
    if (!account || account.status !== 'throttled') return;
    account.status = 'active';
    account.rateLimitedUntil = null;
    account.throttledAt = null;
    console.log(`[TeamClaude] Account "${account.name}" revalidated — rate limit no longer applies, back in rotation`);
  }

  /**
   * Ensure an OAuth account's token is fresh, refreshing if needed.
   * Pass force=true to refresh regardless of expiry (e.g. after a 401).
   * Concurrent calls for the same account coalesce into a single refresh.
   */
  async ensureTokenFresh(accountIndex, force = false) {
    const account = this.accounts[accountIndex];
    if (!account || account.type !== 'oauth' || !account.refreshToken) return;

    if (!force && !isTokenExpiringSoon(account.expiresAt)) return;

    // Coalesce concurrent refreshes
    if (account._refreshPromise) return account._refreshPromise;

    account._refreshPromise = (async () => {
      console.log(`[TeamClaude] Refreshing token for account "${account.name}"...`);
      try {
        const newTokens = await this._refreshFn(account.refreshToken);
        account.credential = newTokens.accessToken;
        account.refreshToken = newTokens.refreshToken;
        account.expiresAt = newTokens.expiresAt;
        console.log(`[TeamClaude] Token refreshed for account "${account.name}"`);
        this._onTokenRefresh?.(accountIndex, newTokens);
      } catch (err) {
        console.error(`[TeamClaude] Token refresh failed for "${account.name}": ${err.message}`);
        // Reserve 'error' (which drops the account from rotation until re-login)
        // for a GENUINE auth rejection: the refresh token itself is no longer
        // valid — revoked, or invalidated by an account/plan migration. A
        // transient failure (network, 5xx, timeout) must NOT sideline a healthy
        // account: keep its current token and retry on the next request. This is
        // what kept accounts wrongly "errored" after a momentary refresh blip.
        const isAuthRejection = err.status === 400 || err.status === 401 || err.status === 403;
        if (isAuthRejection) {
          account.status = 'error';
          console.error(`[TeamClaude] Account "${account.name}" needs re-login (refresh token rejected) — run: teamclaude login`);
        }
      } finally {
        account._refreshPromise = null;
      }
    })();

    return account._refreshPromise;
  }

  /**
   * Set a callback to persist refreshed tokens to config.
   */
  onTokenRefresh(callback) {
    this._onTokenRefresh = callback;
  }

  /**
   * Update a specific account's OAuth tokens (e.g. after intercepting a token refresh).
   */
  updateAccountTokens(accountIndex, { accessToken, refreshToken, expiresAt }) {
    const account = this.accounts[accountIndex];
    if (!account || account.type !== 'oauth') return;

    account.credential = accessToken;
    if (refreshToken) account.refreshToken = refreshToken;
    account.expiresAt = expiresAt;
    if (account.status === 'error') account.status = 'active';
    console.log(`[TeamClaude] Updated tokens for account "${account.name}"`);
    this._onTokenRefresh?.(accountIndex, {
      accessToken,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt,
    });
  }

  /**
   * Add a new account at runtime.
   */
  addAccount(acctData) {
    const index = this.accounts.length;
    this.accounts.push({
      index,
      name: acctData.name,
      type: acctData.type,
      accountUuid: acctData.accountUuid || null,
      orgUuid: acctData.orgUuid || null,
      orgName: acctData.orgName || null,
      priority: acctData.priority || 0,
      disabled: acctData.disabled || false,
      upstream: acctData.upstream || null,
      modelMap: acctData.modelMap || null,
      models: acctData.models || null,
      credential: acctData.accessToken || acctData.apiKey,
      refreshToken: acctData.refreshToken || null,
      expiresAt: acctData.expiresAt || null,
      status: 'active',
      // Unknown quota until the first response — probe it like startup accounts.
      probing: true,
      quota: emptyQuota(),
      observedAt: {},
      usage: { totalInputTokens: 0, totalOutputTokens: 0, totalRequests: 0, lastUsed: null },
      rateLimitedUntil: null,
      throttledAt: null,
    });
    return index;
  }

  /**
   * Remove an account by index.
   */
  removeAccount(index) {
    if (index < 0 || index >= this.accounts.length) return;
    this.accounts.splice(index, 1);
    this.accounts.forEach((a, i) => a.index = i);
    if (this.currentIndex >= this.accounts.length) {
      this.currentIndex = Math.max(0, this.accounts.length - 1);
    } else if (this.currentIndex > index) {
      this.currentIndex--;
    }
    // Keep the manual pin pointing at the same account after the splice: drop it
    // if the pinned account was the one removed, else shift it down past the gap.
    if (this.manualIndex === index) this.manualIndex = null;
    else if (this.manualIndex != null && this.manualIndex > index) this.manualIndex--;
  }

  /**
   * Serialize persistable quota state for all accounts (no credentials), keyed
   * by account identity so it can be matched back after a restart.
   */
  exportQuotaState() {
    return this.accounts.map(a => {
      const quota = {};
      for (const f of PERSISTED_QUOTA_FIELDS) quota[f] = a.quota[f];
      // Persist observedAt alongside quota (item 8) so freshness survives a
      // restart: a restored value keeps its original observation time and reads
      // as stale, rather than looking freshly seen at process start.
      return { accountUuid: a.accountUuid, orgUuid: a.orgUuid, orgName: a.orgName, name: a.name, quota, observedAt: { ...a.observedAt } };
    });
  }

  /**
   * Restore quota learned in a previous run. Matches saved entries to accounts
   * by identity. Stale windows are not special-cased here — _clearExpiredQuotas
   * wipes any restored window whose reset time has already passed on first use.
   */
  restoreQuotaState(saved) {
    if (!Array.isArray(saved)) return;
    for (const account of this.accounts) {
      const match = saved.find(s => sameIdentity(s, account));
      if (!match || !match.quota) continue;
      for (const f of PERSISTED_QUOTA_FIELDS) {
        if (match.quota[f] != null) account.quota[f] = match.quota[f];
      }
      // Restore observation times (item 8) — a restored bucket is NOT freshly
      // observed, so keep the saved timestamp (a bucket that had none stays
      // unstamped, i.e. never observed).
      if (match.observedAt && typeof match.observedAt === 'object') {
        for (const b of OBSERVED_BUCKETS) {
          if (match.observedAt[b] != null) account.observedAt[b] = match.observedAt[b];
        }
      }
      // We already know this account's weekly window, so it isn't "probing".
      if (account.quota.unified7dReset != null) account.probing = false;
    }
  }

  /**
   * Return a status summary of all accounts (safe to expose, no credentials).
   */
  getStatus() {
    return {
      currentAccount: this.accounts[this.currentIndex]?.name,
      manualAccount: this.manualIndex != null ? (this.accounts[this.manualIndex]?.name ?? null) : null,
      switchThreshold: this.switchThreshold,
      routes: this.getRoutes(),
      accounts: this.accounts.map(a => ({
        // Stable identity (item 5b): mutation endpoints target `id`; `email` is a
        // display fallback and `name` the current display label.
        id: accountStableId(a),
        name: a.name,
        email: emailOf(a) || null,
        type: a.type,
        orgName: a.orgName || null,
        priority: a.priority || 0,
        disabled: a.disabled || false,
        status: a.status,
        quota: { ...a.quota },
        // Per-bucket freshness (item 5b/8) as ISO timestamps — NOT HTTP receipt
        // time. Absent buckets were never observed from real traffic.
        observedAt: Object.fromEntries(
          Object.entries(a.observedAt).map(([k, v]) => [k, new Date(v).toISOString()]),
        ),
        usage: { ...a.usage },
        rateLimitedUntil: a.rateLimitedUntil
          ? new Date(a.rateLimitedUntil).toISOString()
          : null,
      })),
    };
  }
}
