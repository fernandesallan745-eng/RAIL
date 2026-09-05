import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
// WHY THERE IS A SCHEDULER IN HERE — RailRadar allows 10 REQUESTS PER MINUTE.
//
// That published burst quota, not the 1,000 req/month tier, is what every 429
// in this repo's history was hitting. The evidence, in the order we found it:
//   * getLiveFleet() fired Promise.allSettled over 20 train numbers at once →
//     429-storm on ALL 5 keys, every refresh. 20 requests in one instant is 2×
//     a whole minute's allowance.
//   * the same 20 issued serially at ~450 ms → 20/20 clean. That looked like a
//     fix, but 450 ms spacing is ~133 req/min; it only worked because the probe
//     was short enough to stay inside one window's slack.
//   * sustained polling at 500 ms spacing → ~1 in 3 attempts still 429'd
//     (measured: 105 attempts, 38 rejections). 120 req/min against a 10 req/min
//     ceiling; backoff-and-retry was papering over a 12× overrun.
//
// So spacing alone is the wrong control — it is a proxy for a rate limit, and a
// proxy that was 12× off. The limit is enforced directly below as a SLIDING
// WINDOW over request-start times, which is the same shape as the quota itself:
// no more than `perMinute` starts in any trailing 60 s. Spacing is kept only as
// a burst smoother so a single user click cannot spend the whole window at once.
//
// Global, not per-method: the fleet poll, the drawer poll and the route fetches
// all spend from one allowance, so throttling them separately would re-create
// the overrun from three directions.
//
// Corollary: key rotation was actively harmful. The limit is per unit time, so
// rotating spreads one overrun across five keys and burns five monthly budgets
// instead of waiting a few seconds. Rotation is now the LAST resort, after
// backoff on the current key.
// ─────────────────────────────────────────────────────────────────────────────

// The axios instance is deliberately module-private and NOT exposed as
// `this.client`. If a future method could reach the raw client it could issue an
// unthrottled call and silently reintroduce the burst 429s above; forcing every
// method through sendUpstream() makes that mistake impossible to make quietly.
const httpClient = axios.create({
  baseURL: config.railRadar.baseUrl,
  timeout: config.railRadar.timeout,
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  },
});

// ── Config accessors ────────────────────────────────────────────────────────
// src/config/env.js owns these values (see the config contract there). They are
// read through accessors rather than snapshotted at import time so getDiagnostics()
// always reports what is actually in effect. The `??`-style fallbacks exist only
// so this module still throttles if it is ever loaded against an older env.js
// that predates the upstream/quota/fleet blocks — an unthrottled default here
// would hand back the exact 429 storm the scheduler was built to stop.
const numOr = (value, fallback) => (Number.isFinite(value) ? value : fallback);

function upstreamLimits() {
  const u = config.upstream || {};
  return {
    concurrency: Math.max(1, numOr(u.concurrency, 2)),
    minSpacingMs: Math.max(0, numOr(u.minSpacingMs, 350)),
    maxRetries: Math.max(0, numOr(u.maxRetries, 3)),
    backoffBaseMs: Math.max(0, numOr(u.backoffBaseMs, 700)),
    // RailRadar's published ceiling is 10/min; the default here is 9 so that
    // clock skew between our window and theirs cannot round us over the line.
    perMinute: Math.max(1, numOr(u.perMinute, 9)),
  };
}

function quotaLimits() {
  const q = config.quota || {};
  return {
    monthlyPerKey: Math.max(0, numOr(q.monthlyPerKey, 1000)),
    guardEnabled: q.guardEnabled !== false,
  };
}

/**
 * Effective key list. env.js pushes every RAILRADAR_API_KEY line into apiKeys[],
 * but the single-key `apiKey` path is kept as a fallback for older configs.
 * Key VALUES never leave this module except as an Authorization header — every
 * log line and every diagnostics field refers to a key by its INDEX only.
 */
function apiKeyList() {
  const keys = config.railRadar.apiKeys || [];
  if (keys.length > 0) return keys;
  return config.railRadar.apiKey ? [config.railRadar.apiKey] : [];
}

// Emergency fleet. env.js owns the curated DEFAULT_FLEET; this two-entry list is
// deliberately NOT a copy of it — duplicating a curated list guarantees the two
// copies drift. It exists purely so the map is not blank if config.fleet is
// missing entirely, and 22229/22230 are the reference demo pair (CLAUDE.md §3).
const EMERGENCY_FLEET = ['22229', '22230'];
let warnedMissingFleetConfig = false;

function fleetPlan() {
  const maxTrains = Math.max(1, numOr(config.fleet?.maxTrains, 8));
  const configured = Array.isArray(config.fleet?.trains) && config.fleet.trains.length > 0
    ? config.fleet.trains.map((n) => String(n).trim()).filter(Boolean)
    : null;

  if (!configured) {
    if (!warnedMissingFleetConfig) {
      warnedMissingFleetConfig = true;
      console.warn('\x1b[33m[RailRadar Service] config.fleet.trains is unset — falling back to the 2-train emergency fleet. Set FLEET_TRAINS in .env or update src/config/env.js.\x1b[0m');
    }
    return { configured: EMERGENCY_FLEET.length, maxTrains, trains: EMERGENCY_FLEET.slice(0, maxTrains) };
  }
  // maxTrains is the live-budget dial: nothing is cached any more, so the number
  // of trains on the map is directly the number of upstream calls per poll.
  return { configured: configured.length, maxTrains, trains: configured.slice(0, maxTrains) };
}

// ── Monthly quota guard ─────────────────────────────────────────────────────
// Live data is no longer cached (deliberate — a cached position is not a live
// position), so the 1,000 req/key/month free tier is now the BINDING constraint
// rather than a distant ceiling. This counter is a budget guard, not an
// authority: it counts what we send, upstream counts what it receives, and the
// two can drift. It errs toward over-counting (every attempt is counted, including
// ones that come back 429) because refusing a call we could have made is cheaper
// than getting the account cut off mid-demo.
//
// Resolved relative to this file, not process.cwd() — same reasoning as commit
// 3c0014e for the .env path: `npm run dev` from a subdirectory must not silently
// start a second, empty counter.
const CACHE_DIR = path.join(__dirname, '../../.cache');
const QUOTA_FILE = path.join(CACHE_DIR, 'rr_quota.json');
const QUOTA_FLUSH_MS = 1500;

/** Local calendar month. Upstream resets on its own clock; close enough for a budget. */
function currentMonthStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

let quotaState = { month: currentMonthStamp(), perKey: [] };
let quotaDirty = false;
let quotaFlushTimer = null;

(function loadQuota() {
  // A missing or corrupt counter file must never stop the server booting — the
  // worst case of starting from zero is that the guard is briefly too generous.
  try {
    const raw = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf-8'));
    if (raw && typeof raw.month === 'string' && Array.isArray(raw.perKey)) {
      quotaState = {
        month: raw.month,
        perKey: raw.perKey.map((n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)),
      };
    }
  } catch (e) {
    // no file yet, or unparseable — start clean
  }
  ensureQuotaMonth();
})();

function ensureQuotaMonth() {
  const month = currentMonthStamp();
  if (quotaState.month !== month) {
    quotaState = { month, perKey: quotaState.perKey.map(() => 0) };
    quotaDirty = true;
    scheduleQuotaFlush();
  }
}

function ensurePerKeyLength(keyCount) {
  while (quotaState.perKey.length < keyCount) quotaState.perKey.push(0);
}

function scheduleQuotaFlush() {
  if (quotaFlushTimer) return;
  // Debounced, not per-request: a synchronous write on every upstream call would
  // add disk latency to the hot path for a counter that only needs to survive a
  // restart. Counts written within the debounce window are lost if the process is
  // killed by a signal ('exit' does not fire for those) — acceptable slack for a
  // guard that already over-counts retries.
  quotaFlushTimer = setTimeout(() => {
    quotaFlushTimer = null;
    flushQuota();
  }, QUOTA_FLUSH_MS);
  if (quotaFlushTimer.unref) quotaFlushTimer.unref();
}

function flushQuota() {
  if (!quotaDirty) return;
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    // Indexed by key POSITION only. No key value is ever written to this file —
    // .cache/ is not a secret store and this file is trivially readable.
    const payload = {
      month: quotaState.month,
      perKey: quotaState.perKey,
      updatedAt: new Date().toISOString(),
      note: 'RailRadar upstream request counts per API key POSITION (never the key value). Reset when `month` rolls over.',
    };
    // tmp + rename so a crash mid-write cannot leave a truncated JSON behind.
    const tmp = `${QUOTA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tmp, QUOTA_FILE);
    quotaDirty = false;
  } catch (e) {
    console.warn(`\x1b[33m[RailRadar Service] Could not persist quota counters: ${e.message}\x1b[0m`);
  }
}

process.on('exit', () => {
  if (quotaDirty) flushQuota();
});

function countUpstreamRequest(keyIndex) {
  ensureQuotaMonth();
  ensurePerKeyLength(keyIndex + 1);
  quotaState.perKey[keyIndex] += 1;
  quotaDirty = true;
  scheduleQuotaFlush();
  totalRequests += 1;
}

/**
 * First key at or after `from` (wrapping) that is neither already tried for this
 * request nor over its monthly budget. Returns -1 when there is none.
 */
function pickKeyIndex(from, keyCount, monthlyPerKey, guardEnabled, skip) {
  for (let step = 0; step < keyCount; step++) {
    const idx = ((from % keyCount) + keyCount + step) % keyCount;
    if (skip.has(idx)) continue;
    if (guardEnabled && (quotaState.perKey[idx] || 0) >= monthlyPerKey) continue;
    return idx;
  }
  return -1;
}

// ── The global upstream scheduler ───────────────────────────────────────────
const queue = [];
let inFlight = 0;
let lastStartAt = 0;
let pumpTimer = null;
let totalRequests = 0;
// A 429 is a property of the UPSTREAM, not of the one request that tripped it, so
// it has to apply back-pressure to every caller. Without this, the other seven
// fleet requests keep firing during the first one's backoff and reproduce the
// burst immediately.
let cooldownUntil = 0;

// Request-start timestamps inside the trailing rate window, oldest first. This is
// the authoritative rate limiter: the quota is "N starts per 60 s", so the state
// it needs is the start times themselves, not an average gap.
const RATE_WINDOW_MS = 60000;
const recentStarts = [];

/**
 * How long until a new request may start without exceeding `perMinute` in the
 * trailing 60 s. Prunes aged-out starts as it goes, which is what keeps
 * `recentStarts` bounded (at most `perMinute` entries survive a prune).
 *
 * Returns 0 when there is room now.
 */
function rateWindowWaitMs(now, perMinute) {
  while (recentStarts.length > 0 && now - recentStarts[0] >= RATE_WINDOW_MS) {
    recentStarts.shift();
  }
  if (recentStarts.length < perMinute) return 0;
  // Window is full. The next slot opens exactly when the oldest start ages out —
  // +1 ms so the comparison above is strictly satisfied on the retry.
  return recentStarts[0] + RATE_WINDOW_MS - now + 1;
}

let activeKeyIndex = 0;
let count429 = 0;
let last429At = null;
let lastRetryAfterSec = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Queue one upstream attempt. Resolves/rejects with whatever the task does. */
function schedule(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

function pump() {
  // A wake-up is already pending; it will drain the queue when it fires. Bounded
  // by minSpacingMs, the rate window, or the active cooldown — so nothing can be
  // starved indefinitely.
  if (pumpTimer) return;

  const { concurrency, minSpacingMs, perMinute } = upstreamLimits();
  while (queue.length > 0 && inFlight < concurrency) {
    const now = Date.now();
    // Gate on all three independently: the inter-request smoother, the hard
    // per-minute quota, and any global 429 cooldown. The longest wins.
    const waitMs = Math.max(
      lastStartAt + minSpacingMs - now,
      cooldownUntil - now,
      rateWindowWaitMs(now, perMinute)
    );
    if (waitMs > 0) {
      // Deliberately NOT unref'd: a queued upstream call is real pending work and
      // the process must not be allowed to exit out from under it.
      pumpTimer = setTimeout(() => {
        pumpTimer = null;
        pump();
      }, waitMs);
      return;
    }

    const job = queue.shift();
    lastStartAt = now;
    // Counted at START, matching how the upstream window sees it. Counting on
    // completion would let N slow requests all start inside one window.
    recentStarts.push(now);
    inFlight += 1;
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        inFlight -= 1;
        pump();
      });
  }
}

/**
 * Retry-After is seconds or an HTTP-date per RFC 7231; accept either.
 */
function parseRetryAfter(raw) {
  if (raw == null) return null;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber >= 0) return asNumber;
  const asDate = Date.parse(raw);
  if (!Number.isNaN(asDate)) return Math.max(0, (asDate - Date.now()) / 1000);
  return null;
}

// Retry-After is honoured but clamped: an upstream "come back in 300s" would
// otherwise park an Express handler well past the browser's patience and past our
// own 15 s axios timeout. Exponential backoff is clamped lower still.
const MAX_HONOURED_RETRY_AFTER_MS = 15000;
const MAX_BACKOFF_MS = 8000;

function backoffDelayMs(attempt, backoffBaseMs, retryAfterSec) {
  if (retryAfterSec != null) {
    return Math.min(Math.ceil(retryAfterSec * 1000), MAX_HONOURED_RETRY_AFTER_MS);
  }
  const target = Math.min(backoffBaseMs * 2 ** attempt, MAX_BACKOFF_MS);
  // Equal jitter: half the delay fixed, half random. With several fleet requests
  // backing off at once, an unjittered delay would re-synchronise them into a
  // fresh burst the moment it elapsed.
  return Math.round(target / 2 + Math.random() * (target / 2));
}

function recordRateLimit(err) {
  count429 += 1;
  last429At = new Date().toISOString();
  lastRetryAfterSec = err?.retryAfterSec ?? null;
}

/**
 * The single upstream entry point. Throttled, retried with backoff, quota-guarded.
 * @param {Object} cfg - axios request config (url/method/params/data)
 */
async function sendUpstream(cfg) {
  const keys = apiKeyList();
  if (keys.length === 0) {
    const error = new Error('RAILRADAR_API_KEY is not configured in .env. Please set your RailRadar API key to make live requests.');
    error.status = 401;
    throw error;
  }

  const { maxRetries, backoffBaseMs } = upstreamLimits();
  const { monthlyPerKey, guardEnabled } = quotaLimits();

  ensureQuotaMonth();
  ensurePerKeyLength(keys.length);

  const tried = new Set();
  let keyIndex = pickKeyIndex(activeKeyIndex, keys.length, monthlyPerKey, guardEnabled, tried);

  if (keyIndex === -1) {
    // Every key is over budget. Refuse locally instead of hammering upstream with
    // requests it will reject anyway — that is how an account gets suspended.
    const error = new Error(
      `RailRadar monthly budget exhausted: all ${keys.length} key(s) have used their ${monthlyPerKey} requests for ${quotaState.month} (${keys.length * monthlyPerKey} total). Refusing to call upstream. Set RAILRADAR_QUOTA_GUARD=false to override.`
    );
    error.status = 429;
    error.quotaExhausted = true;
    throw error;
  }

  let lastError = null;

  while (keyIndex !== -1) {
    activeKeyIndex = keyIndex;
    // Kept in sync so /api/health's masked key display tracks the key actually in
    // use. The value is never logged or returned unmasked.
    config.railRadar.apiKey = keys[keyIndex];

    // Backoff FIRST, rotate second. On a burst limit the correct response is to
    // wait — the limit is per unit time, not per key — so retrying the same key
    // after a pause succeeds where jumping to key #2 just moves the burst.
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const authValue = keys[keyIndex].startsWith('Bearer ')
          ? keys[keyIndex]
          : `Bearer ${keys[keyIndex]}`;
        const response = await schedule(() => {
          countUpstreamRequest(keyIndex);
          return httpClient.request({
            ...cfg,
            headers: { ...(cfg.headers || {}), Authorization: authValue },
          });
        });
        return response;
      } catch (err) {
        lastError = err;
        if (err.status !== 429) throw err;

        recordRateLimit(err);

        // A MONTHLY quota wall is the one case where rotating first is right.
        // Backoff exists to ride out a per-minute burst limit; it can do nothing
        // about an allowance that does not reset until next month. Waiting here
        // would just burn the demo clock, so mark this key spent and move on.
        if (err.isMonthlyQuota) {
          console.warn(`\x1b[33m[RailRadar Service] Key #${keyIndex} monthly quota exhausted upstream (not a burst limit — backoff cannot recover it). Marking spent and rotating.\x1b[0m`);
          quotaState.perKey[keyIndex] = Math.max(quotaState.perKey[keyIndex] || 0, monthlyPerKey);
          quotaDirty = true;
          scheduleQuotaFlush();
          break;
        }

        const delayMs = backoffDelayMs(attempt, backoffBaseMs, err.retryAfterSec);
        // Slow every other caller down too, not just this one.
        cooldownUntil = Math.max(cooldownUntil, Date.now() + delayMs);

        if (attempt < maxRetries) {
          console.warn(`\x1b[33m[RailRadar Service] Upstream 429 on Key #${keyIndex} (attempt ${attempt + 1}/${maxRetries + 1}). Backing off ${delayMs} ms${err.retryAfterSec != null ? ` (Retry-After: ${err.retryAfterSec}s)` : ''}...\x1b[0m`);
          await sleep(delayMs);
        }
      }
    }

    tried.add(keyIndex);
    const next = pickKeyIndex(keyIndex + 1, keys.length, monthlyPerKey, guardEnabled, tried);
    if (next === -1) break;
    const why = lastError?.isMonthlyQuota
      ? 'monthly quota exhausted'
      : `still rate-limited after ${maxRetries + 1} attempts`;
    console.warn(`\x1b[33m[RailRadar Service] Key #${keyIndex} ${why}. Rotating to Key #${next} as a last resort...\x1b[0m`);
    keyIndex = next;
  }

  if (lastError) {
    // Annotated, not re-worded: the 401/404/429/504 message mapping below is what
    // the UI surfaces and is intentionally left intact.
    lastError.attemptsExhausted = true;
    lastError.keysTried = tried.size;
    console.warn(`\x1b[33m[RailRadar Service] Gave up after ${tried.size} key(s) × ${maxRetries + 1} attempts. Upstream allows ${upstreamLimits().perMinute} req/min — lower RAILRADAR_PER_MINUTE or FLEET_MAX_TRAINS rather than adding keys (the limit is per unit time, so more keys do not buy more throughput).\x1b[0m`);
    throw lastError;
  }

  const error = new Error('RailRadar request could not be dispatched (no usable API key).');
  error.status = 429;
  throw error;
}

// Response interceptor: error normalisation ONLY. Retry/rotation used to live in
// here, which meant a burst 429 triggered an instant key switch with no pause —
// exactly backwards. That decision now belongs to sendUpstream().
httpClient.interceptors.response.use(
  (res) => res,
  (error) => {
    const customError = new Error();

    if (error.response) {
      customError.status = error.response.status;
      customError.data = error.response.data;
      // RailRadar returns the reason in one of three shapes depending on
      // endpoint: {error:{message}}, {message}, or a bare string {error}.
      // Keep the raw text — the 429 branch below has to pattern-match on it.
      const rawMsg =
        error.response.data?.error?.message ||
        error.response.data?.message ||
        (typeof error.response.data?.error === 'string' ? error.response.data.error : null) ||
        `RailRadar API error (${error.response.status})`;
      customError.message = rawMsg;

      if (error.response.status === 401) {
        customError.message = 'Invalid or missing RailRadar API key. Please check RAILRADAR_API_KEY in your .env file.';
      } else if (error.response.status === 404) {
        customError.message = 'Requested train or railway resource not found on RailRadar.';
      } else if (error.response.status === 429) {
        // 429 covers two different failures behind one status code, and they need
        // opposite responses: a per-minute burst limit clears in seconds (back
        // off), a monthly quota does not (rotate). The only way to tell them apart
        // is the upstream's own wording, so keep that message rather than
        // overwriting it with a generic one.
        customError.isMonthlyQuota = Boolean(
          typeof rawMsg === 'string' && rawMsg.toLowerCase().includes('monthly quota')
        );
        if (!customError.isMonthlyQuota) {
          customError.message = 'RailRadar rate limit exceeded. Please wait a moment or upgrade your plan.';
        }
        // Surfaced so sendUpstream() can honour the upstream's own pacing hint
        // instead of guessing with exponential backoff.
        customError.retryAfterSec = parseRetryAfter(error.response.headers?.['retry-after']);
      }
    } else if (error.request) {
      customError.status = 504;
      customError.message = 'No response received from RailRadar API (Request Timed Out).';
    } else {
      customError.status = 500;
      customError.message = error.message || 'Internal error setting up RailRadar request.';
    }

    return Promise.reject(customError);
  }
);

// ── Immutable track geometry ────────────────────────────────────────────────
// READ THIS BEFORE "FIXING" IT: this is a cache of TRACK SHAPE, not of train
// position, and it does not make the fleet less live.
//
// The live call used to request geometry:true on every poll — ~164 KB per train,
// per refresh, of a polyline that has not moved since the line was laid. The
// track is immutable, so it is fetched once per train and reused; subsequent
// polls pass geometry:false. The train's distance-from-origin (the thing that
// actually changes) is still fetched fresh on every single poll, and the upstream
// REQUEST COUNT is completely unchanged — only the payload shrinks. Nothing here
// serves a stale position.
//
// The derived cumulative-distance array is stored alongside it: it is a pure
// function of the polyline, so recomputing 1,184 haversines per train per poll
// bought nothing.
const trackGeometryCache = new Map(); // trainNumber → { polyline, cumDist, polyTotal }

/** [[lng,lat],...] → { polyline: [[lat,lng],...], cumDist, polyTotal } */
function buildTrack(coords) {
  // Convert [lng,lat] → [lat,lng] for the polyline (GeoJSON order, CLAUDE.md VERIFIED #1)
  const polyline = coords.map((c) => [c[1], c[0]]);

  // Compute cumulative distance along polyline
  const cumDist = [0];
  for (let i = 1; i < polyline.length; i++) {
    const dLat = (polyline[i][0] - polyline[i - 1][0]) * Math.PI / 180;
    const dLng = (polyline[i][1] - polyline[i - 1][1]) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(polyline[i - 1][0] * Math.PI / 180) * Math.cos(polyline[i][0] * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    const km = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    cumDist.push(cumDist[i - 1] + km);
  }

  return { polyline, cumDist, polyTotal: cumDist[cumDist.length - 1] };
}

/**
 * Interpolate a live position along the cached track. Maths unchanged from the
 * verified inline version — only the polyline/cumDist inputs are now reused.
 */
function interpolateAlongTrack(track, trainDistKm, totalRouteDist) {
  const { polyline, cumDist, polyTotal } = track;
  const scale = polyTotal / totalRouteDist;
  const targetPoly = Math.max(0, Math.min(polyTotal, trainDistKm * scale));

  // Binary search for the segment
  let lo = 0, hi = cumDist.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    cumDist[mid] <= targetPoly ? lo = mid : hi = mid;
  }
  const segLen = cumDist[hi] - cumDist[lo];
  const t = segLen > 0 ? (targetPoly - cumDist[lo]) / segLen : 0;
  return {
    lat: polyline[lo][0] + t * (polyline[hi][0] - polyline[lo][0]),
    lng: polyline[lo][1] + t * (polyline[hi][1] - polyline[lo][1]),
  };
}

class RailRadarService {
  /**
   * Helper to ensure API key is configured before making calls
   */
  ensureApiKey() {
    if (!config.railRadar.apiKey) {
      const error = new Error('RAILRADAR_API_KEY is not configured in .env. Please set your RailRadar API key to make live requests.');
      error.status = 401;
      throw error;
    }
  }

  /**
   * Get train timetable, stops, and schedule details
   * @param {string|number} trainNumber
   */
  async getTrainSchedule(trainNumber) {
    this.ensureApiKey();
    const cleanNumber = String(trainNumber).trim();
    const response = await sendUpstream({ url: `/trains/${cleanNumber}`, method: 'GET' });
    return response.data;
  }

  /**
   * Get real-time running status, delays, and current location
   * @param {string|number} trainNumber
   * @param {Object} params - optional query params (e.g. date)
   */
  async getTrainLiveStatus(trainNumber, params = {}) {
    this.ensureApiKey();
    const cleanNumber = String(trainNumber).trim();
    const response = await sendUpstream({ url: `/trains/${cleanNumber}/live`, method: 'GET', params });
    return response.data;
  }

  /**
   * Get GeoJSON route track geometry for map rendering
   * @param {string|number} trainNumber
   */
  async getTrainRoute(trainNumber) {
    this.ensureApiKey();
    const cleanNumber = String(trainNumber).trim();
    const response = await sendUpstream({ url: `/trains/${cleanNumber}/route`, method: 'GET' });
    return response.data;
  }

  /**
   * Get coach composition and layout
   * @param {string|number} trainNumber
   */
  async getTrainCoaches(trainNumber) {
    this.ensureApiKey();
    const cleanNumber = String(trainNumber).trim();
    const response = await sendUpstream({ url: `/trains/${cleanNumber}/coaches`, method: 'GET' });
    return response.data;
  }

  /**
   * Autocomplete/search trains by number or name
   * @param {string} query
   */
  async searchTrains(query) {
    this.ensureApiKey();
    const cleanQuery = String(query).trim();
    // RailRadar supports search via /lookup/search/trains or /lookup/trains
    try {
      const response = await sendUpstream({
        url: '/lookup/search/trains',
        method: 'GET',
        params: { query: cleanQuery, q: cleanQuery },
      });
      return response.data;
    } catch (err) {
      // Fallback endpoint if format varies
      if (err.status === 404) {
        const response = await sendUpstream({
          url: '/trains/search',
          method: 'GET',
          params: { query: cleanQuery, q: cleanQuery },
        });
        return response.data;
      }
      throw err;
    }
  }

  /**
   * Get train categories list
   */
  async getTrainCategories() {
    this.ensureApiKey();
    const response = await sendUpstream({ url: '/lookup/trains/categories', method: 'GET' });
    return response.data;
  }

  /**
   * Get live fleet overview for radar map.
   *
   * The train list comes from config.fleet (FLEET_TRAINS / DEFAULT_FLEET, capped
   * by FLEET_MAX_TRAINS) — it used to be 20 hardcoded numbers here, two of which
   * (10111/10112) 404 on RailRadar and two of which (01131/01132) are the
   * never-GPS-tracked zero-echo tier from CLAUDE.md VERIFIED #4. Since live data
   * is no longer cached, the fleet size IS the per-poll upstream request count,
   * so it belongs in config where it can be turned down.
   *
   * Every entry is fetched live on every call. Concurrency is bounded by the
   * global scheduler above, so the Promise.allSettled fan-out below can no longer
   * turn into a burst.
   */
  async getLiveFleet() {
    this.ensureApiKey();

    const plan = fleetPlan();
    const trains = plan.trains;

    const fleet = [];
    // Why each train dropped out, per train. A silently-empty fleet is the worst
    // failure mode here: the controller reacts by serving the disk fallback, so a
    // recurring live failure looks like a working map with slightly old positions.
    // Every `return null` below records its reason first.
    const failures = [];

    // Promise.allSettled keeps one dead train number from blanking the whole map.
    const promises = trains.map(async (num) => {
      try {
        // Ask for geometry only until we have this train's track shape; after that
        // the immutable polyline is reused and we skip ~164 KB of payload per poll.
        // See the trackGeometryCache note above — position stays live either way.
        const cachedTrack = trackGeometryCache.get(num);
        // includeCoordinates adds lat/lng to every route station. It costs no
        // extra upstream REQUEST — it is a param on the call we already make —
        // and without it the tunnel layer cannot anchor its chainage to the
        // timetable axis and silently degrades to a global scale factor
        // (see src/services/tunnels.js, "the AXIS").
        const liveRes = await this.getTrainLiveStatus(num, cachedTrack
          ? { geometry: false, includeCoordinates: true }
          : { geometry: true, geometry_format: 'geojson', includeCoordinates: true });
        // Stamped as close to the upstream response as possible: with live caching
        // off, "when did we actually ask?" is the claim the UI needs to be able
        // to make honestly.
        const fetchedAt = new Date().toISOString();
        const liveData = liveRes?.data || liveRes;

        if (!liveData) {
          failures.push({ number: num, reason: 'upstream returned no data object' });
          return null;
        }

        const trainInfo = liveData.train || {};
        const currentLoc = liveData.currentLocation || {};
        const prevHalt = liveData.previousHalt || {};
        const nextHalt = liveData.nextHalt || {};

        // ── Compute actual train position via polyline interpolation ──
        let lat = null;
        let lng = null;

        let track = cachedTrack || null;
        if (!track) {
          // Extra `geojson` wrapper is a RailRadar quirk, not a typo (VERIFIED #1)
          const coords = liveData.geometry?.geojson?.geometry?.coordinates; // [[lng,lat], ...]
          if (coords && coords.length > 1) {
            track = buildTrack(coords);
            trackGeometryCache.set(num, track);
          }
        }

        const route = liveData.route || [];
        const trainDistKm = currentLoc.distanceFromOriginKm;
        const totalRouteDist = route.length > 0
          ? Math.max(...route.map((s) => s.distance || 0))
          : 0;

        if (track && trainDistKm != null && totalRouteDist > 0) {
          const pos = interpolateAlongTrack(track, trainDistKm, totalRouteDist);
          lat = pos.lat;
          lng = pos.lng;
        }

        // Fallback: source station if interpolation failed
        if (!lat || !lng) {
          if (trainInfo.source && trainInfo.source.lat) {
            lat = trainInfo.source.lat;
            lng = trainInfo.source.lng;
          }
        }

        // No position and no source station → report nothing. This used to default
        // to 28.6139/77.2090 (New Delhi), which drew Konkan trains in Delhi and
        // then survived the truthiness filter below because the default is truthy.
        // A fabricated position is worse than a missing one; it counts as `failed`.
        if (lat == null || lng == null) {
          // Named inputs, not just "no position": which one is missing says whether
          // the cause is the polyline, the live distance, or the route array.
          failures.push({
            number: num,
            reason: 'could not place train on map',
            status: liveData.status ?? null,
            hasTrack: !!track,
            distanceFromOriginKm: trainDistKm ?? null,
            routeStops: route.length,
            totalRouteDist,
            hasSourceLatLng: !!(trainInfo.source && trainInfo.source.lat),
          });
          return null;
        }

        const trackingMode = liveData.trackingMode ?? null;

        return {
          number: liveData.trainNumber || num,
          name: liveData.trainName || trainInfo.name || `Train ${num}`,
          type: trainInfo.type || 'Express',
          category: trainInfo.category || 'Express',
          status: liveData.status || 'running',
          // Absent liveness must not read as "live". `?? true` here is how a
          // completed, never-tracked run (01132) ended up rendered as a live
          // train — see trackingMode/isTracked below.
          isLive: liveData.isLive === true,
          delayMinutes: liveData.delayMinutes ?? 0,
          currentStation: currentLoc.stationName || currentLoc.stationCode || 'En Route',
          previousHalt: prevHalt.stationName || null,
          nextHalt: nextHalt.stationName || null,
          source: trainInfo.source?.name || trainInfo.source?.code || '',
          destination: trainInfo.destination?.name || trainInfo.destination?.code || '',
          sourceCode: trainInfo.source?.code || '',
          destCode: trainInfo.destination?.code || '',
          lat,
          lng,
          // NOTE: speedToNextStationKmph is SCHEDULE-DERIVED, not a live GPS speed
          // (CLAUDE.md VERIFIED #3). The UI must label it as scheduled, never "live".
          // Falls back to null rather than an invented 60 km/h — a made-up number
          // presented next to real ones is the kind of thing that loses a pitch.
          speed: currentLoc.speedToNextStationKmph || trainInfo.avgSpeed || null,
          lastUpdated: liveData.lastUpdatedAt || new Date().toISOString(),
          // Raw upstream tracking mode. 'real-time' means an actual GPS-backed
          // feed; 'none' means the run is in the zero-echo tier (VERIFIED #4) and
          // its "delay 0 / On Time" is an echo of the timetable, not an observation.
          trackingMode,
          isTracked: trackingMode === 'real-time',
          // When WE fetched this position (vs lastUpdated, which is when upstream
          // says it was observed). Both are needed to back a "never cached" claim.
          dataAsOf: fetchedAt,
        };
      } catch (err) {
        // A swallowed error here is why an empty fleet used to be unexplainable.
        // Surfaced AND logged: the controller's disk fallback makes a persistent
        // live failure look like a working map, so the reason has to be visible.
        failures.push({
          number: num,
          reason: err?.message || String(err),
          status: err?.status ?? null,
        });
        console.warn(`\x1b[33m[RailRadar Service] Fleet train ${num} failed: ${err?.status ?? '—'} ${err?.message || err}\x1b[0m`);
        return null;
      }
    });

    const results = await Promise.allSettled(promises);
    let failed = 0;
    results.forEach((res) => {
      const value = res.status === 'fulfilled' ? res.value : null;
      if (value && value.lat != null && value.lng != null) {
        fleet.push(value);
      } else {
        failed += 1;
        // A rejected promise means the try/catch above did not run (shouldn't
        // happen, but an unrecorded failure would be invisible again).
        if (res.status === 'rejected') {
          failures.push({ number: '(unknown)', reason: res.reason?.message || String(res.reason) });
        }
      }
    });

    if (failed > 0) {
      console.warn(`\x1b[33m[RailRadar Service] Fleet: ${fleet.length}/${trains.length} placed, ${failed} failed. Reasons: ${JSON.stringify(failures)}\x1b[0m`);
    }

    return {
      count: fleet.length,
      timestamp: new Date().toISOString(),
      fleet,
      // Untracked trains are returned, not hidden — the UI labels them. Dropping
      // them silently would leave the map looking complete when it is not.
      untracked: fleet.filter((t) => !t.isTracked).length,
      requested: trains.length,
      failed,
      failures,
    };
  }

  /**
   * Generic proxy request forwarding to RailRadar
   * @param {string} path - subpath e.g. /trains/12002/live
   * @param {string} method - GET, POST, etc.
   * @param {Object} query - Query parameters
   * @param {Object} body - Request body
   */
  async proxyRequest(path, method = 'GET', query = {}, body = null) {
    this.ensureApiKey();
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    // Routed through the scheduler like everything else: the passthrough proxy
    // spends the same upstream budget as the map does.
    const response = await sendUpstream({
      url: cleanPath,
      method,
      params: query,
      data: body,
    });
    return response.data;
  }

  /**
   * Operational snapshot for /api/health and the admin console. Everything here is
   * counts, indices and config — never a key value.
   */
  getDiagnostics() {
    const keys = apiKeyList();
    const { concurrency, minSpacingMs, perMinute } = upstreamLimits();
    const { monthlyPerKey, guardEnabled } = quotaLimits();
    const plan = fleetPlan();

    ensureQuotaMonth();
    ensurePerKeyLength(keys.length);

    const perKey = keys.map((_, index) => {
      const used = quotaState.perKey[index] || 0;
      return { index, used, remaining: Math.max(0, monthlyPerKey - used) };
    });

    // Prunes as it measures, so usedInWindow is the live trailing-60s count.
    const windowWaitMs = rateWindowWaitMs(Date.now(), perMinute);

    return {
      keys: keys.length,
      activeKeyIndex,
      upstream: {
        concurrency,
        minSpacingMs,
        inFlight,
        queued: queue.length,
        // Every upstream attempt since boot, retries included — this is the number
        // that must stay comfortably under the monthly budget.
        totalRequests,
      },
      // The binding constraint. If usedInWindow sits at the limit and throttledMs
      // is non-zero, requests are being correctly delayed rather than 429'd —
      // that is the scheduler working, not a fault.
      rateWindow: {
        perMinute,
        windowSeconds: RATE_WINDOW_MS / 1000,
        usedInWindow: recentStarts.length,
        remainingInWindow: Math.max(0, perMinute - recentStarts.length),
        throttledMs: windowWaitMs,
      },
      quota: {
        month: quotaState.month,
        guardEnabled,
        monthlyPerKey,
        perKey,
        totalUsed: perKey.reduce((sum, k) => sum + k.used, 0),
        totalRemaining: perKey.reduce((sum, k) => sum + k.remaining, 0),
        exhausted: keys.length > 0 && perKey.every((k) => k.remaining === 0),
      },
      rateLimit: {
        count429,
        last429At,
        lastRetryAfterSec,
      },
      fleet: {
        // `configured` is the list before the FLEET_MAX_TRAINS cap; `trains` is
        // what is actually polled.
        configured: plan.configured,
        maxTrains: plan.maxTrains,
        trains: plan.trains,
      },
      cachePolicy: {
        liveTtlSeconds: config.cache.liveTtl,
        staticTtlSeconds: config.cache.staticTtl,
        // Live positions are never served from cache (liveTtl 0 = bypass). Static
        // route/timetable/coach data keeps its 24 h TTL — a route polyline is
        // immutable, so re-downloading it cannot make anything fresher, and caching
        // it is what makes the live budget affordable. Deliberate exception.
        liveCachingDisabled: !(config.cache.liveTtl > 0),
      },
    };
  }
}

export const railRadarService = new RailRadarService();
