/**
 * Admin-surface controllers: model-API proxies and the one safe operator action.
 *
 * WHY THESE EXIST AT ALL — the admin UI is served by this Node gateway on :5050, but
 * every model number it renders comes from the Python FastAPI service on :8000, and
 * that service has NO CORS middleware. A browser on :5050 therefore cannot call it
 * directly; these passthroughs are the only route. (Checked, not assumed: there is no
 * CORSMiddleware anywhere in api.py.)
 *
 * COST: zero upstream RailRadar requests. The model service is cache-only — it reads
 * .cache/ and computes. Nothing in this file can spend the 1,000 req/month tier.
 */
import axios from 'axios';
import { config } from '../config/env.js';
import { cache, clearCache } from '../middleware/cache.js';

/**
 * Shared error translation for every model passthrough.
 *
 * "the model said no" and "the model isn't running" are different failures and must not
 * collapse into one blank panel — an empty ETA panel and a 503 look identical on screen
 * and mean opposite things (VERIFIED #9). Each carries its own reason code so the UI can
 * say which happened.
 */
const sendModelError = (res, error, what) => {
  const status = error.response?.status;
  if (status === 422) {
    return res.status(422).json({
      success: false,
      reason: 'invalid-parameters',
      detail: error.response.data?.detail || null,
    });
  }
  if (status === 404) {
    return res.status(404).json({
      success: false,
      reason: 'not-cached',
      detail: error.response.data?.detail || `no cached data for this ${what}`,
    });
  }
  return res.status(503).json({
    success: false,
    reason: 'model-unreachable',
    detail: error.message,
    hint: 'start the ETA model: python3 run_server.py 8000',
  });
};

/** Only forward params the model actually accepts, and drop empties. */
const pickParams = (query, allowed) => {
  const params = {};
  for (const key of allowed) {
    const v = query[key];
    if (v !== undefined && v !== '') params[key] = v;
  }
  return params;
};

/**
 * GET /api/model/run-state/:trainNumber — the run-day calendar answer alone.
 *
 * Pure passthrough. Only the roster knows which weekdays a train runs, and the
 * roster is 7.9 MB — too large to parse per request in Node, which is why the
 * calendar lives in conflict.py and this route exists at all. Costs zero
 * upstream RailRadar requests.
 *
 * Note this is the CALENDAR half only. The live half (running / completed /
 * awaiting-departure) is resolved by resolveRunState in train.controller.js and
 * rides on the live payload as `data.runState`; that is what the UI reads. This
 * route is for the admin console and for asking about a date other than today.
 */
export const getModelRunState = async (req, res) => {
  try {
    const { trainNumber } = req.params;
    const params = pickParams(req.query, ['date']);
    const upstream = await axios.get(
      `${config.modelApi.baseUrl}/run-state/${trainNumber}`,
      { params, timeout: 5000 }
    );
    res.json({ success: true, data: upstream.data });
  } catch (error) {
    sendModelError(res, error, 'train');
  }
};

/**
 * GET /api/model/eta/:trainNumber — the full layered ETA breakdown.
 *
 * Pure passthrough: the gateway does no ETA arithmetic of its own, the same discipline
 * the tunnel and conflict layers follow, so the two can never disagree about a number.
 *
 * `hazards` is on the allowlist because `pickParams` DROPS anything absent from it,
 * silently — a request with `?hazards=true` came back `enabled: false` and looked like
 * a broken model rather than a swallowed parameter. That is the THIRD call site into
 * the model's /eta (drawer live, drawer cached-fallback, here), which is VERIFIED #13's
 * lesson for the third time: fixing one path leaves the others quietly wrong.
 */
export const getModelEta = async (req, res) => {
  try {
    const { trainNumber } = req.params;
    const params = pickParams(req.query, ['date', 'weather', 'mode', 'max_speed', 'hazards']);
    const upstream = await axios.get(
      `${config.modelApi.baseUrl}/eta/${trainNumber}`,
      { params, timeout: 20000 }   // curvature integration over ~1,200 vertices
    );
    res.json({ success: true, data: upstream.data });
  } catch (error) {
    sendModelError(res, error, 'train');
  }
};

/** GET /api/model/health — the model's own cache audit and layer availability. */
export const getModelHealth = async (req, res) => {
  try {
    const upstream = await axios.get(`${config.modelApi.baseUrl}/health`, { timeout: 10000 });
    res.json({ success: true, data: upstream.data });
  } catch (error) {
    sendModelError(res, error, 'model');
  }
};

/** GET /api/model/geometry/:trainNumber — decimated polyline for drawing. */
export const getModelGeometry = async (req, res) => {
  try {
    const { trainNumber } = req.params;
    const params = pickParams(req.query, ['max_points']);
    const upstream = await axios.get(
      `${config.modelApi.baseUrl}/geometry/${trainNumber}`,
      { params, timeout: 15000 }
    );
    res.json({ success: true, data: upstream.data });
  } catch (error) {
    sendModelError(res, error, 'train');
  }
};

/**
 * POST /api/admin/cache/flush — clear the gateway's in-memory response cache.
 *
 * SCOPE IS THE WHOLE POINT. This clears node-cache ONLY: the static TTL entries this
 * process holds (route polylines, schedules, the corridor sweep). It does NOT touch
 * `.cache/` on disk, which is the offline corpus the entire model is built on and would
 * cost ~1,000 upstream requests to rebuild — that is a destructive action, not a safe op,
 * and nothing in the browser may trigger it.
 *
 * Flushing costs no upstream requests by itself. It means the NEXT request for a static
 * resource re-fetches, so it is reported as "next fetch is a miss", not as free.
 *
 * POST-only so that a prefetch, a crawler or a mistyped URL cannot fire it.
 */
export const flushGatewayCache = (req, res) => {
  // Counted before and after rather than asserted: "it flushed" is a claim, a key count
  // that went 42 → 0 is evidence. Same discipline as printing intermediate numbers.
  const before = cache.keys().length;
  clearCache();
  const after = cache.keys().length;

  res.json({
    success: true,
    scope: 'node-gateway-memory-cache',
    keysBefore: before,
    keysAfter: after,
    keysCleared: before - after,
    diskCacheTouched: false,
    note: 'Cleared this gateway\'s in-memory response cache only. The .cache/ corpus on '
        + 'disk is untouched. The next request for a static resource will re-fetch from '
        + 'RailRadar and spend one upstream request.',
  });
};
