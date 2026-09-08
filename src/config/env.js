import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

// Recalculating keys on watch reload

// Extract all instances of RAILRADAR_API_KEY from .env manually
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const apiKeys = [];
try {
  const envPath = path.join(__dirname, '../../.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const lines = envContent.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const idx = trimmed.indexOf('=');
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        if ((key === 'RAILRADAR_API_KEY' || key.startsWith('RAILRADAR_API_KEY_') || key === 'RAILRADAR_API_KEYS') && val) {
          // Strip quotes if present and split by comma if multiple
          const cleanVal = val.replace(/^["']|["']$/g, '').trim();
          const splitKeys = cleanVal.split(/[,\s\n]+/).map(k => k.trim()).filter(Boolean);
          for (const k of splitKeys) {
            if (k && !apiKeys.includes(k)) {
              apiKeys.push(k);
            }
          }
        }
      }
    }
  }
} catch (e) {
  // fallback to environment variables
}

// Support cloud environment variables (e.g. Render, Railway, Docker)
const envKeySources = [
  process.env.RAILRADAR_API_KEYS,
  process.env.RAILRADAR_API_KEY,
  process.env.RAILRADAR_API_KEY_1,
  process.env.RAILRADAR_API_KEY_2,
  process.env.RAILRADAR_API_KEY_3,
  process.env.RAILRADAR_API_KEY_4,
  process.env.RAILRADAR_API_KEY_5,
];

for (const src of envKeySources) {
  if (src && typeof src === 'string') {
    const splitKeys = src.split(/[,\s\n]+/).map(k => k.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    for (const k of splitKeys) {
      if (k && !apiKeys.includes(k)) {
        apiKeys.push(k);
      }
    }
  }
}

// Every knob below is an integer read from .env, and a typo'd value must not silently become
// NaN. NaN propagates badly here: `slice(0, NaN)` returns an EMPTY fleet, i.e. a map with no
// trains and no error message anywhere. Fall back to the documented default and say so instead.
// Tests for a finite number, never for truthiness — 0 is a *legal* value for CACHE_TTL_LIVE
// (it is how live caching gets switched off) and must survive the parse.
const intEnv = (name, fallback, min = 0) => {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const parsed = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    console.warn(`\x1b[33m⚠️  [Config] Ignoring ${name}="${raw}" — expected an integer >= ${min}. Using ${fallback}.\x1b[0m`);
    return fallback;
  }
  return parsed;
};

// Trains polled by getLiveFleet(). ONE train, deliberately.
//
// RailRadar allows 10 REQUESTS PER MINUTE. Since live data is not cached, the fleet size IS
// the per-poll upstream request count, so an 8-train fleet spent 8 of those 10 on a single
// refresh and left nothing for the drawer, the route fetch or a user click. One train polling
// once a minute spends 1 — the rest of the window stays free for whatever the operator does
// during the demo. This is the whole reason the 429s stopped; it is not arbitrary trimming.
//
// 12051 is the Jan Shatabdi (CSMT → Madgaon), confirmed `trackingMode: "real-time"` by direct
// probe on 2026-08-31. It runs the Konkan corridor, so it exercises exactly the geometry the
// curvature layer is built around.
const DEFAULT_FLEET = [
  '12051', // Jan Shatabdi CSMT → MAO — the single live train (see the 10 req/min note above)
];

// Also probed `trackingMode: "real-time"` on 2026-08-31 and safe to use, but every added train
// is another request per poll out of a 10/min allowance. Select them at runtime with
// FLEET_TRAINS (and raise FLEET_MAX_TRAINS to match) rather than growing DEFAULT_FLEET, and do
// the arithmetic first: N trains at a 60 s poll costs N req/min.
//   '22229', // Vande Bharat CSMT → MAO — CLAUDE.md reference demo train
//   '22230', // Vande Bharat MAO → CSMT (the return working)
//   '12133', // Mangaluru Jn SF Express
//   '12134', // Mumbai CSMT SF Express
//   '10103', // Mandovi Express
//   '16346', // Netravati Express
//   '12618', // Mangala Lakshadweep Express
//   '12052', // Jan Shatabdi MAO → CSMT
//   '10104', // Mandovi Express (return)
//   '16345', // Netravati Express (return)
//   '12779', // Goa Express
//   '12780', // Goa Express (return)
//   '12619', // Matsyagandha Express
//   '12620', // Matsyagandha Express (return)
//   '12617', // Mangala Lakshadweep Express (return)
//
// NEVER put these back in any fleet list — probed 2026-08-31:
//   10111, 10112 → HTTP 404, the numbers do not exist on RailRadar. Dead entries.
//   01131, 01132 → trackingMode:"none", isLive:false. That is the zero-echo tier of
//                  CLAUDE.md VERIFIED #4; rendering them puts a completed, never-GPS-tracked
//                  run on the map labelled "On Time", which is an honesty bug, not a feature.

// Cap first — the fleet list is sliced to it, so it has to be a sane integer before we parse
// the list. min 1: a cap of 0 would mean "poll nothing" and show an empty map.
const fleetMaxTrains = intEnv('FLEET_MAX_TRAINS', 1, 1);

// FLEET_TRAINS overrides DEFAULT_FLEET. Comma- *or* whitespace-separated, because the operator
// typing this at demo time will use whichever they reach for first. Dedupe so a repeated number
// cannot quietly eat two slots of the request budget.
const parseFleetTrains = (raw) => {
  if (!raw || !String(raw).trim()) return DEFAULT_FLEET;
  const parsed = [...new Set(
    String(raw)
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
  )];
  return parsed.length > 0 ? parsed : DEFAULT_FLEET;
};

const fleetTrains = parseFleetTrains(process.env.FLEET_TRAINS).slice(0, fleetMaxTrains);

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  // The Python FastAPI ETA model (curvature / delay / dwell). Single source of truth: this
  // used to be the literal 'http://127.0.0.1:8000' repeated in four places in the controller,
  // which drifts the moment the model runs on another port.
  modelApi: {
    baseUrl: (process.env.MODEL_API_URL || 'http://127.0.0.1:8000').replace(/\/+$/, ''),
  },
  railRadar: {
    apiKey: apiKeys[0] || '',
    apiKeys: apiKeys,
    baseUrl: (process.env.RAILRADAR_BASE_URL || 'https://api.railradar.in/v1').replace(/\/+$/, ''),
    timeout: parseInt(process.env.REQUEST_TIMEOUT_MS || '15000', 10),
  },
  cache: {
    // liveTtl defaults to 0 = NEVER cache live data. Every poll of live status / fleet position
    // is a real upstream call, by explicit request: a cached train position is a stale train
    // position, and showing one as if it were live is the same class of honesty bug as
    // rendering an untracked run as "On Time". 0 must be handled as "bypass the cache
    // entirely" by the consumer — note that node-cache reads stdTTL:0 as "never expire",
    // which is the exact opposite, so the middleware cannot just forward this number.
    liveTtl: intEnv('CACHE_TTL_LIVE', 0),
    // DELIBERATE EXCEPTION — do not "fix" this to 0 to match liveTtl. staticTtl covers route
    // polylines, coach composition and timetables, all of which are immutable for the run:
    // re-downloading a polyline cannot make anything fresher, it just burns quota. Caching
    // static data for 24 h is precisely what makes the uncached live budget affordable.
    staticTtl: intEnv('CACHE_TTL_STATIC', 86400),
  },
  fleet: {
    trains: fleetTrains,
    maxTrains: fleetMaxTrains,
  },
  // One global scheduler throttles ALL upstream RailRadar calls. perMinute is the real
  // constraint — RailRadar allows 10 req/min, and that ceiling (not the monthly tier) is what
  // every 429 in this repo's history was hitting. Default 9 leaves one request of margin for
  // clock skew between our window and theirs. minSpacingMs is now only a burst smoother: it
  // stops one user click from spending the whole minute's allowance in 200 ms.
  upstream: {
    concurrency: intEnv('RAILRADAR_CONCURRENCY', 1, 1),
    perMinute: intEnv('RAILRADAR_PER_MINUTE', 9, 1),
    minSpacingMs: intEnv('RAILRADAR_MIN_SPACING_MS', 1500),
    maxRetries: intEnv('RAILRADAR_MAX_RETRIES', 3),
    backoffBaseMs: intEnv('RAILRADAR_BACKOFF_BASE_MS', 700),
  },
  // With nothing live cached, the monthly cap (1,000 req/key/month) is now the binding
  // constraint rather than the burst limit, so the guard counts requests and refuses to
  // overrun the budget instead of discovering it as a wall of 429s mid-demo.
  quota: {
    monthlyPerKey: intEnv('RAILRADAR_MONTHLY_QUOTA_PER_KEY', 1000),
    guardEnabled: (process.env.RAILRADAR_QUOTA_GUARD || 'true') !== 'false',
  },
};

export const validateConfig = () => {
  if (config.railRadar.apiKeys.length === 0) {
    console.warn('\x1b[33m⚠️  [RailRadar Config Warning] No RAILRADAR_API_KEY is set in .env. API calls will return 401 until configured.\x1b[0m');
  } else {
    console.log(`\x1b[32m✔ [RailRadar Config] Loaded ${config.railRadar.apiKeys.length} API keys successfully. Active: ${config.railRadar.apiKey.slice(0, 8)}...\x1b[0m`);
  }

  // One-line posture summary. This is what tells the operator at demo time that live mode is
  // actually active — "is this position live or cached?" is the first question asked of the map
  // and it should be answerable from the boot log, not by reading source.
  const { trains, maxTrains } = config.fleet;
  const { concurrency, minSpacingMs, perMinute } = config.upstream;
  const budget = config.quota.guardEnabled
    ? `${config.railRadar.apiKeys.length} × ${config.quota.monthlyPerKey} = ${config.railRadar.apiKeys.length * config.quota.monthlyPerKey} req/month`
    : 'quota guard OFF';
  const liveMode = config.cache.liveTtl === 0
    ? 'LIVE every poll (live cache OFF)'
    : `live cached ${config.cache.liveTtl}s`;
  console.log(
    `\x1b[36mℹ [Posture]\x1b[0m fleet ${trains.length}/${maxTrains} (${trains.join(', ')}) · ${liveMode} · static cache ${config.cache.staticTtl}s · upstream ≤${perMinute} req/min, ${concurrency} concurrent @ ≥${minSpacingMs}ms · budget ${budget}`
  );

  // Loud, because it silently contradicts the whole point of the change: a non-zero live TTL
  // means the map can show a position up to that many seconds old while presenting it as live.
  if (config.cache.liveTtl !== 0) {
    console.warn(`\x1b[33m⚠️  [Posture] CACHE_TTL_LIVE=${config.cache.liveTtl} — live responses may be served from cache and are NOT guaranteed fresh. Set CACHE_TTL_LIVE=0 for true live mode.\x1b[0m`);
  }
};
