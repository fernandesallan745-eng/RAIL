import { Router } from 'express';
import {
  getHealth,
  getTrainSchedule,
  getTrainLiveStatus,
  getTrainRoute,
  getTrainCoaches,
  searchTrains,
  getTrainCategories,
  getLiveFleet,
  getTunnels,
  getCorridorConflicts,
  proxyPass,
} from '../controllers/train.controller.js';
import { cacheMiddleware } from '../middleware/cache.js';
import {
  getModelEta,
  getModelHealth,
  getModelGeometry,
  getModelRunState,
  flushGatewayCache,
} from '../controllers/admin.controller.js';
import { config } from '../config/env.js';

const router = Router();

// ─── Caching policy ──────────────────────────────────────────────────────────────────────────
// LIVE endpoints use config.cache.liveTtl, which defaults to 0 = never cached. Every request is
// a real upstream call, so a position shown on the map is a position fetched now.
//
// STATIC endpoints keep config.cache.staticTtl (24 h). A route polyline, coach layout and
// timetable are immutable for the run — re-downloading them cannot make anything fresher, it
// only burns quota. Caching those is exactly what makes uncached live polling affordable, so
// this asymmetry is deliberate: do not "fix" the static TTLs to 0 to match live.
//
// Bursts are prevented in src/services/railradar.js by one global scheduler, not here. The
// cache is no longer load protection, so it must not be relied on as such.
// ─────────────────────────────────────────────────────────────────────────────────────────────

// Health check, credentials state, live posture & quota diagnostics
router.get('/health', getHealth);

// LIVE — Konkan fleet positions. Uncached: every poll hits RailRadar.
router.get('/trains/radar/fleet', cacheMiddleware(config.cache.liveTtl), getLiveFleet);

// STATIC — tunnel zones are local JSON, not upstream data
router.get('/tunnels/zones', cacheMiddleware(3600), getTunnels);

// STATIC — every predicted crossing on the corridor for a service date.
// Cached for an hour: the sweep reads only cached TIMETABLES, so its answer
// changes when the date changes, not minute to minute, and it costs zero
// upstream requests either way. The TTL is here to spare the 206-train sweep,
// not the RailRadar quota.
router.get('/corridor/conflicts', cacheMiddleware(3600), getCorridorConflicts);

// STATIC — search results for a train number/name don't change within a demo
router.get('/trains/search', cacheMiddleware(config.cache.staticTtl), searchTrains);

// LIVE — running status, current location, delay. Uncached.
router.get('/trains/:trainNumber/live', cacheMiddleware(config.cache.liveTtl), getTrainLiveStatus);
// STATIC — immutable per run (see policy note above)
router.get('/trains/:trainNumber/route', cacheMiddleware(config.cache.staticTtl), getTrainRoute);
router.get('/trains/:trainNumber/coaches', cacheMiddleware(config.cache.staticTtl), getTrainCoaches);
router.get('/trains/:trainNumber', cacheMiddleware(config.cache.staticTtl), getTrainSchedule);

// STATIC — lookups
router.get('/lookup/categories', cacheMiddleware(86400), getTrainCategories);

// ─── Model API passthroughs (admin UI) ───────────────────────────────────────────────────────
// The Python model service on :8000 has no CORS middleware, so a browser page served from
// this origin cannot call it directly — these routes are the only path. All three are
// cache-only on the model side and cost ZERO upstream RailRadar requests, so the TTLs here
// exist to spare recomputation, not quota.
router.get('/model/health', cacheMiddleware(60), getModelHealth);
router.get('/model/eta/:trainNumber', cacheMiddleware(300), getModelEta);
router.get('/model/geometry/:trainNumber', cacheMiddleware(config.cache.staticTtl), getModelGeometry);
// Run-day calendar for one train on one date. Deliberately a SHORT TTL, not the
// 24 h static one: the answer is date-specific, and a day-long cache would keep
// serving yesterday's "runs today" across midnight — the same staleness the
// persist strip in train.controller.js exists to prevent (VERIFIED #21).
router.get('/model/run-state/:trainNumber', cacheMiddleware(300), getModelRunState);

// ─── Operator actions ────────────────────────────────────────────────────────────────────────
// POST-only, and deliberately the only mutating route in this API. It clears this process's
// in-memory cache and nothing else — never the .cache/ corpus on disk (see the controller).
router.post('/admin/cache/flush', flushGatewayCache);

// Transparent proxy for any RailRadar endpoint
router.all('/proxy/*', proxyPass);

export default router;
