import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { railRadarService } from '../services/railradar.js';
import { config } from '../config/env.js';
import { cache } from '../middleware/cache.js';
import { enhanceLiveData, getTunnelZones } from '../services/deadReckoning.js';
import { liveVelocityTracker } from '../services/liveVelocityTracker.js';
import { weatherService } from '../services/weatherService.js';
import { hazardHealth } from './hazard.controller.js';

const FALLBACK_DIR = path.join(process.cwd(), '.cache');
const FALLBACK_FILE = path.join(FALLBACK_DIR, 'fleet_fallback.json');

// Ensure cache folder exists
if (!fs.existsSync(FALLBACK_DIR)) {
  fs.mkdirSync(FALLBACK_DIR, { recursive: true });
}

/** Local calendar date as YYYY-MM-DD. `toISOString()` is UTC and would roll the
 *  date over after 18:30 IST, reporting tomorrow's run-state all evening. */
const localDateStr = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/**
 * Decide, server-side, what run-state a train is actually in.
 *
 * This exists because the UI was rendering `distanceFromOriginKm: 0` as a
 * measured zero ("0 km covered") for trains that had not departed or were not
 * running at all — VERIFIED #9 at the UI layer, and the defect the user
 * reported. The answer is resolved HERE, not in the browser, so the map and the
 * admin console cannot drift, and so the calendar logic stays in one language
 * (`conflict.py`) rather than being re-derived in JavaScript.
 *
 * Resolution order — live observation outranks the calendar, because a train
 * that is observably running is running whatever the roster says:
 *
 *   1. status 'running'      -> running
 *   2. status 'completed'    -> completed
 *   3. status 'not-started'  -> AMBIGUOUS, split by `startDate`:
 *        startDate  > date   -> not running on `date`; upstream is already
 *                               showing the NEXT run (VERIFIED #4)
 *        startDate == date   -> scheduled today, awaiting departure
 *        startDate  < date   -> stale snapshot; defer to the calendar
 *   4. anything else         -> defer to the calendar
 *
 * Step 3 is the part that is easy to get wrong. 'not-started' reads like "has
 * not departed yet", but 22229 and 07361 are both 'not-started' *because they
 * do not run today* — upstream had moved on to 2026-09-14 and 2026-09-15
 * respectively. Verified against the roster calendar: for every cached
 * not-started train with a future startDate, upstream's date and the
 * independently-computed nextRunDate agree exactly (2 of 2, zero
 * disagreements). Treating all three cases as "awaiting departure" would put
 * tomorrow's run on today's map.
 *
 * Costs ZERO upstream requests: `status`/`startDate` ride on the live payload we
 * already fetched, and the calendar is read from the cached roster.
 */
export const resolveRunState = async (trainNumber, liveData, serviceDate) => {
  const date = serviceDate || localDateStr();
  const status = liveData && typeof liveData.status === 'string'
    ? liveData.status.toLowerCase()
    : null;
  // Plain 'YYYY-MM-DD' upstream (verified on 3 cached trains), but slice
  // defensively in case it ever arrives as a full ISO timestamp.
  const startDate = liveData && liveData.startDate
    ? String(liveData.startDate).slice(0, 10)
    : null;

  const base = {
    train: String(trainNumber),
    serviceDate: date,
    liveStatus: status,
    startDate,
    // Prediction/reporting only, never a control action (CLAUDE.md §2).
    decisionSupportOnly: true,
  };

  if (status === 'running') {
    return { ...base, state: 'running', basis: 'live-status', isMoving: true };
  }
  if (status === 'completed') {
    return { ...base, state: 'completed', basis: 'live-status', isMoving: false };
  }

  // The calendar is consulted for everything else. Asked for unconditionally
  // (not just on the miss) so the payload can report BOTH sources and flag a
  // disagreement instead of quietly preferring one.
  let calendar = null;
  try {
    const rs = await axios.get(
      `${config.modelApi.baseUrl}/run-state/${trainNumber}`,
      { params: { date }, timeout: config.modelApi.requestTimeoutMs || 8000 }
    );
    calendar = rs.data || null;
  } catch (err) {
    const is422 = err.response && err.response.status === 422;
    calendar = {
      unavailable: true,
      reason: is422 ? 'invalid-date' : 'model-unreachable',
      detail: is422 ? (err.response.data?.detail || null) : err.message,
    };
  }
  const calendarOk = calendar && !calendar.unavailable;
  const runsToday = calendarOk ? calendar.runsToday : undefined;

  if (status === 'not-started') {
    if (startDate && startDate > date) {
      // Upstream has rolled to the next run: this train is NOT running on
      // `date`. Prefer upstream's own date over the roster's — it is the live
      // source — but carry both so the disagreement is auditable, not hidden.
      return {
        ...base,
        state: 'not-running-today',
        basis: 'live-start-date',
        isMoving: false,
        nextRunDate: startDate,
        calendarNextRunDate: calendarOk ? calendar.nextRunDate : null,
        calendarAgrees: calendarOk ? calendar.nextRunDate === startDate : null,
        runDays: calendarOk ? calendar.runDays : null,
        note: `Not running on ${date}. Upstream is showing the next run on ${startDate}.`,
        calendar,
      };
    }
    if (startDate && startDate < date) {
      // A snapshot older than the service date. Its 'not-started' described a
      // past day, so it says nothing about today — fall through to the calendar
      // rather than claiming a departure that may already have happened.
      return {
        ...base,
        state: runsToday === true ? 'awaiting-departure'
          : runsToday === false ? 'not-running-today'
            : 'unknown',
        basis: calendarOk ? 'roster-calendar-stale-snapshot' : 'unresolved',
        isMoving: false,
        nextRunDate: calendarOk ? calendar.nextRunDate : null,
        runDays: calendarOk ? calendar.runDays : null,
        note: `Cached snapshot is from ${startDate}, before ${date}; run-state taken from the roster calendar instead.`,
        calendar,
      };
    }
    // startDate == date, or absent: scheduled today and not yet away. This is
    // the state that used to render "0 km covered (0%)" with a 15% bar.
    return {
      ...base,
      state: 'awaiting-departure',
      basis: startDate ? 'live-start-date' : 'live-status',
      isMoving: false,
      runDays: calendarOk ? calendar.runDays : null,
      note: 'Scheduled today; has not departed yet, so no distance has been covered.',
      calendar,
    };
  }

  // No usable live status: the calendar is all we have.
  if (runsToday === true) {
    return {
      ...base, state: 'scheduled-today', basis: 'roster-calendar', isMoving: null,
      runDays: calendar.runDays,
      note: 'Runs today per the roster calendar; no live status available for it.',
      calendar,
    };
  }
  if (runsToday === false) {
    return {
      ...base, state: 'not-running-today', basis: 'roster-calendar', isMoving: false,
      nextRunDate: calendar.nextRunDate, runDays: calendar.runDays,
      note: calendar.note, calendar,
    };
  }
  // Tri-state preserved to the end: unknown is NOT "does not run" (VERIFIED #9).
  return {
    ...base,
    state: 'unknown',
    basis: calendarOk ? (calendar.basis || 'no-calendar') : 'unresolved',
    isMoving: null,
    note: calendarOk
      ? (calendar.note || 'Run calendar unavailable for this train.')
      : 'Neither a live status nor a run calendar is available for this train.',
    calendar,
  };
};

/**
 * The `hazards` query parameter for a model /eta call, from the caller's request.
 *
 * ONE helper for BOTH call sites deliberately. The live path and the cached-fallback
 * path are two separate `axios.get(fastApiUrl)` calls, and VERIFIED #13 records
 * exactly this shape of bug: `includeCoordinates` was fixed in the service and the
 * drawer stayed broken because nobody noticed the second call site. A hazard flag
 * that reached one path and not the other would make the layer appear and vanish
 * depending on whether upstream happened to be up.
 *
 * Off unless explicitly asked for, so the default ETA reproduces §4b exactly — the
 * same contract `conflicts=False` has in eta_model.compute_eta.
 */
const hazardParam = (req) => (
  req?.query?.hazards === 'true' ? { hazards: 'true' } : {}
);

// Model layer in-memory cache for fast repeated polling on live deployment
// Key: trainNumber:serviceDate:delayMin:weather:quantile:hazards
// TTL: 45 seconds
const modelLayerCache = new Map();
const lastKnownGoodModels = new Map(); // trainNumber -> { curvatureEta, conflicts, runState, timestamp }

const getModelCacheKey = (trainNumber, date, delayMin, weather, quantile, hazards) => {
  return `${trainNumber}:${date}:${delayMin}:${weather}:${quantile}:${hazards ? '1' : '0'}`;
};

/**
 * Concurrently attach weather, curvature ETA, single-line conflict prediction,
 * and run-state to a train data payload with in-memory caching and fallback continuity.
 */
async function attachModelLayers(trainNumber, liveData, req, isFallback = false) {
  const curLoc = liveData.currentLocation || {};
  const curLat = Number(liveData.lat ?? curLoc.lat ?? curLoc.coordinates?.lat ?? liveData.previousHalt?.lat ?? 18.9);
  const curLng = Number(liveData.lng ?? curLoc.lng ?? curLoc.coordinates?.lng ?? liveData.previousHalt?.lng ?? 73.0);

  const startDate = liveData.startDate
    ? String(liveData.startDate).slice(0, 10)
    : localDateStr();
  const delayMin = Number.isFinite(Number(liveData.delayMinutes))
    ? Number(liveData.delayMinutes)
    : 0;

  const weatherParam = req?.query?.weather || 'live';
  const quantileParam = req?.query?.quantile || 'mean';
  const hazardParams = hazardParam(req);
  const timeoutMs = config.modelApi.requestTimeoutMs || 8000;

  // 1. Check in-memory cache for rapid 30s auto-refresh cycles
  const cacheKey = getModelCacheKey(
    trainNumber,
    startDate,
    delayMin,
    weatherParam,
    quantileParam,
    Boolean(hazardParams.hazards)
  );

  const cached = modelLayerCache.get(cacheKey);
  const now = Date.now();
  if (cached && (now - cached.timestamp < 45000)) {
    return {
      weather: cached.weather,
      curvatureEta: cached.curvatureEta,
      curvatureEtaUnavailable: cached.curvatureEtaUnavailable,
      conflicts: cached.conflicts,
      conflictsUnavailable: cached.conflictsUnavailable,
      runState: cached.runState,
    };
  }

  // 2. Build concurrent promises
  // 2.1 Weather
  const weatherPromise = (async () => {
    try {
      if (Number.isFinite(curLat) && Number.isFinite(curLng) && weatherParam === 'live') {
        return await weatherService.getPointWeather(curLat, curLng);
      }
      return weatherService.fallback(isFallback ? 'cached-run' : 'clear-sky');
    } catch {
      return weatherService.fallback(isFallback ? 'cached-run' : 'clear-sky');
    }
  })();

  // 2.2 Curvature ETA
  const etaPromise = (async () => {
    try {
      const fastApiUrl = `${config.modelApi.baseUrl}/eta/${trainNumber}`;
      const fastApiRes = await axios.get(fastApiUrl, {
        params: {
          date: startDate,
          weather: weatherParam,
          quantile: quantileParam,
          delay: delayMin,
          ...hazardParams,
        },
        timeout: timeoutMs,
      });
      if (fastApiRes.data) {
        const eta = fastApiRes.data;
        if (eta.schedule_date_substituted) {
          eta.is_fallback_date = true;
        }
        return { curvatureEta: eta };
      }
      return {};
    } catch (err) {
      const is404 = err.response && err.response.status === 404;
      const detail = err.response?.data?.detail;
      if (is404) {
        console.log(
          `[FastAPI integration] No ETA model cache for train ${trainNumber} — ` +
          `serving live tracking without curvature/delay ETA.` +
          (detail ? ` Model said: ${detail}` : '')
        );
      } else {
        console.warn(`[FastAPI integration] Curvature ETA model offline or failed: ${err.message}`);
      }
      return {
        curvatureEtaUnavailable: {
          reason: is404 ? 'not-in-model-cache' : 'model-unreachable',
          train: trainNumber,
          detail: (is404 ? detail : err.message) || null,
          modelReachable: Boolean(is404),
        },
      };
    }
  })();

  // 2.3 Single-line Conflicts
  const conflictPromise = (async () => {
    try {
      const conflictRes = await axios.get(
        `${config.modelApi.baseUrl}/conflicts/${trainNumber}`,
        {
          params: { delay: delayMin, live_delays: true, feedback: true },
          timeout: timeoutMs,
        }
      );
      if (conflictRes.data) {
        const cData = conflictRes.data;
        cData.delayBasis = isFallback ? 'cached' : 'live';
        return { conflicts: cData };
      }
      return {};
    } catch (err) {
      const is404 = err.response && err.response.status === 404;
      const detail = err.response?.data?.detail;
      const reason = is404 ? 'not-in-corridor-cache' : 'model-unreachable';
      console.warn(
        `[Conflict layer] Unavailable for ${trainNumber} (${reason})` +
        (is404 ? ' — run: python3 scripts/build_corridor.py' : `: ${err.message}`)
      );
      return {
        conflictsUnavailable: {
          reason,
          train: trainNumber,
          detail: (is404 ? detail : err.message) || null,
          modelReachable: Boolean(is404),
        },
      };
    }
  })();

  // 2.4 Run state
  const runStatePromise = (async () => {
    try {
      return await resolveRunState(trainNumber, liveData);
    } catch (err) {
      console.warn(`[Run state] Unresolved for ${trainNumber}: ${err.message}`);
      return {
        train: String(trainNumber),
        state: 'unknown',
        basis: 'unresolved',
        isMoving: null,
        note: isFallback ? 'Run-state could not be resolved from the cached snapshot.' : 'Run-state could not be resolved.',
        detail: err.message,
      };
    }
  })();

  // Execute all 4 in parallel
  const [weatherSettled, etaSettled, conflictSettled, runStateSettled] =
    await Promise.allSettled([
      weatherPromise,
      etaPromise,
      conflictPromise,
      runStatePromise,
    ]);

  const weather = weatherSettled.status === 'fulfilled'
    ? weatherSettled.value
    : weatherService.fallback(isFallback ? 'cached-run' : 'clear-sky');
  const etaResult = etaSettled.status === 'fulfilled' ? etaSettled.value : {};
  const conflictResult = conflictSettled.status === 'fulfilled' ? conflictSettled.value : {};
  const runState = runStateSettled.status === 'fulfilled' ? runStateSettled.value : {
    train: String(trainNumber),
    state: 'unknown',
    basis: 'unresolved',
    isMoving: null,
    note: 'Run-state could not be resolved.',
  };

  let curvatureEta = etaResult.curvatureEta;
  let curvatureEtaUnavailable = etaResult.curvatureEtaUnavailable;
  let conflicts = conflictResult.conflicts;
  let conflictsUnavailable = conflictResult.conflictsUnavailable;

  // 3. Continuity Guard: If transient timeout/unreachable occurs, fall back to last-known-good
  const lastGood = lastKnownGoodModels.get(trainNumber);
  if (!conflicts && conflictsUnavailable?.reason === 'model-unreachable' && lastGood?.conflicts) {
    conflicts = { ...lastGood.conflicts, transientFallback: true };
    conflictsUnavailable = undefined;
    console.warn(`[Conflict layer] Transient timeout for ${trainNumber} — serving last known good prediction to prevent UI flicker.`);
  }

  if (!curvatureEta && curvatureEtaUnavailable?.reason === 'model-unreachable' && lastGood?.curvatureEta) {
    curvatureEta = { ...lastGood.curvatureEta, transientFallback: true };
    curvatureEtaUnavailable = undefined;
    console.warn(`[Curvature ETA] Transient timeout for ${trainNumber} — serving last known good prediction to prevent UI flicker.`);
  }

  // 4. Update last known good if valid
  if (conflicts || curvatureEta || runState) {
    lastKnownGoodModels.set(trainNumber, {
      conflicts: conflicts || lastGood?.conflicts,
      curvatureEta: curvatureEta || lastGood?.curvatureEta,
      runState: runState || lastGood?.runState,
      timestamp: now,
    });
  }

  const payload = {
    weather,
    curvatureEta,
    curvatureEtaUnavailable,
    conflicts,
    conflictsUnavailable,
    runState,
    timestamp: now,
  };

  // Cache in-memory for 45 seconds
  modelLayerCache.set(cacheKey, payload);

  return payload;
}


/**
 * Attach `runState` to every entry of a fleet array, in place.
 *
 * The map draws a non-running train at its ORIGIN STATION (railradar.js falls
 * back to source lat/lng when there is no live position), so a train that is not
 * running today is a marker sitting on the map like any other. Without this the
 * popup reported a green "On Time" for it — the same class of defect as the
 * drawer's "0 km covered (0%)".
 *
 * Costs zero upstream RailRadar requests: run-state is `status`/`startDate` from
 * the payload we already have, plus the cached roster calendar.
 *
 * DELIBERATELY NOT called before the disk persist (VERIFIED #21): run-state is
 * derived from a service date, so a persisted copy would be wrong the moment the
 * file outlives the day. Fallback reads call this again to recompute.
 */
const attachFleetRunStates = async (fleet) => {
  if (!Array.isArray(fleet) || !fleet.length) return fleet;
  const date = localDateStr();
  await Promise.all(fleet.map(async (entry) => {
    if (!entry || !entry.number) return;
    try {
      entry.runState = await resolveRunState(entry.number, entry, date);
    } catch (err) {
      // Never fatal: a marker with an unresolved state is still a real position.
      entry.runState = {
        train: String(entry.number),
        serviceDate: date,
        state: 'unknown',
        basis: 'unresolved',
        isMoving: null,
        note: 'Run-state could not be resolved.',
        detail: err.message,
      };
    }
  }));
  return fleet;
};

export const getHealth = (req, res) => {  // Upstream posture (quota burned, 429 count, scheduler queue depth, active fleet) is
  // surfaced here rather than left in the server logs because with live caching disabled
  // the monthly cap — 1,000 req/key/month — is now the binding constraint, not the cache.
  // "How much budget is left and did we get throttled?" has to be answerable from the
  // browser during the demo, without shelling into the box to read stdout.
  //
  // Guarded on purpose: /health is the endpoint an operator hits precisely *when things
  // are broken*, so it must never be the thing that throws. If the service layer is
  // mid-reload (nodemon) or predates getDiagnostics(), say so instead of returning a 500.
  const upstream = typeof railRadarService.getDiagnostics === 'function'
    ? railRadarService.getDiagnostics()
    : { unavailable: true, reason: 'railRadarService.getDiagnostics() not available' };

  res.json({
    success: true,
    status: 'online',
    serverTime: new Date().toISOString(),
    railRadar: {
      baseUrl: config.railRadar.baseUrl,
      apiKeyConfigured: Boolean(config.railRadar.apiKey && config.railRadar.apiKey.length > 0),
      apiKeyMasked: config.railRadar.apiKey
        ? `${config.railRadar.apiKey.slice(0, 4)}...${config.railRadar.apiKey.slice(-4)}`
        : 'NOT_SET',
    },
    // Raw keys never appear here — only the count, the active index and the masked form
    // above. `upstream.quota.perKey` reports usage positionally for the same reason.
    upstream,
    cache: {
      cachedKeysCount: cache.keys().length,
      liveTtlSeconds: config.cache.liveTtl,
      staticTtlSeconds: config.cache.staticTtl,
      // Authoritative live/static policy (incl. liveCachingDisabled) is upstream.cachePolicy.
      // Not duplicated into this block: two copies of the same state drift.
    },
    // Published so the browser can link to the model service (audit console, OpenAPI docs)
    // without hardcoding a second copy of the port in front-end code.
    modelApi: {
      baseUrl: config.modelApi.baseUrl,
    },
    // Phase 7 hazard layer. Guarded for the same reason `upstream` is: /health is the
    // endpoint an operator hits when things are broken, so an unreadable hazard store must
    // not be the thing that takes it down. `adminTokenConfigured` is a boolean — the token
    // value itself never reaches the browser, same rule as the RailRadar keys.
    hazards: (() => {
      try {
        return hazardHealth();
      } catch (e) {
        return { unavailable: true, reason: 'hazard-store-unreadable', detail: e.message };
      }
    })(),
  });
};

export const getTrainSchedule = async (req, res, next) => {
  try {
    const { trainNumber } = req.params;
    if (!trainNumber) {
      return res.status(400).json({ success: false, message: 'Train number is required.' });
    }
    const data = await railRadarService.getTrainSchedule(trainNumber);
    res.json({
      success: true,
      trainNumber,
      data,
    });
  } catch (error) {
    next(error);
  }
};

export const getTrainLiveStatus = async (req, res, next) => {
  const { trainNumber } = req.params;
  if (!trainNumber) {
    return res.status(400).json({ success: false, message: 'Train number is required.' });
  }

  try {
    // 1. Fetch raw live status and route geometry in parallel
    //
    // includeCoordinates puts lat/lng on every route station. Without it the
    // tunnel layer has nothing to anchor its chainage to and silently falls back
    // to a single global scale factor — ~585 m of axis error, which is longer
    // than the median Konkan tunnel (593 m), i.e. enough to name the wrong one
    // (see src/services/tunnels.js, "the AXIS"). It is a parameter on the call
    // we already make, so it costs no extra upstream request.
    //
    // req.query spreads FIRST so a caller can still override for debugging, but
    // the browser never sends this param, so in practice we always add it.
    const [liveDataRaw, routeGeoJsonRaw] = await Promise.allSettled([
      railRadarService.getTrainLiveStatus(trainNumber, {
        includeCoordinates: true,
        ...req.query,
      }),
      railRadarService.getTrainRoute(trainNumber)
    ]);

    const liveDataObj = liveDataRaw.status === 'fulfilled' ? liveDataRaw.value : null;
    const routeGeoJson = routeGeoJsonRaw.status === 'fulfilled' ? routeGeoJsonRaw.value : null;

    if (!liveDataObj) {
      // If the primary live status call failed, check if it was due to rate limiting (429)
      const errorReason = liveDataRaw.reason || {};
      if (errorReason.status === 429 || errorReason.response?.status === 429) {
        throw errorReason; // propagate to catch block for cache fallback
      }
      throw new Error(`Failed to fetch live status for train #${trainNumber}`);
    }

    // Extract inner payload depending on nesting structure
    const liveData = liveDataObj.data?.data || liveDataObj.data || liveDataObj;

    // 2. Augment live status with Dead Reckoning tunnel/stale-signal tracking
    const enhancedData = enhanceLiveData(liveData, routeGeoJson);

    // 2.1 Calculate instantaneous GPS velocity, Kalman smoothing & horizon speed blending
    const curLoc = liveData.currentLocation || {};
    const curCoords = curLoc.coordinates || {};
    const curLat = Number(liveData.lat ?? curCoords.lat ?? curLoc.lat);
    const curLng = Number(liveData.lng ?? curCoords.lng ?? curLoc.lng);
    const curTime = liveData.lastUpdatedAt || curLoc.lastUpdatedAt || new Date().toISOString();
    const schedSpeed = Number(curLoc.speedToNextStationKmph || curLoc.speedKmh || liveData.train?.avgSpeed || 0) || null;
    const nxtHalt = liveData.nextHalt || {};
    const distToNextHalt = Number(nxtHalt.distance ?? curLoc.distanceToNextStationKm) || null;

    enhancedData.liveVelocity = liveVelocityTracker.recordPing(
      trainNumber,
      { lat: curLat, lng: curLng, distanceFromOriginKm: curLoc.distanceFromOriginKm },
      curTime,
      schedSpeed,
      distToNextHalt
    );

    // 2.2 Concurrently attach weather, curvature ETA, conflict prediction, and run-state
    const modelLayers = await attachModelLayers(trainNumber, liveData, req, false);
    enhancedData.weather = modelLayers.weather;
    if (modelLayers.curvatureEta) enhancedData.curvatureEta = modelLayers.curvatureEta;
    if (modelLayers.curvatureEtaUnavailable) enhancedData.curvatureEtaUnavailable = modelLayers.curvatureEtaUnavailable;
    if (modelLayers.conflicts) enhancedData.conflicts = modelLayers.conflicts;
    if (modelLayers.conflictsUnavailable) enhancedData.conflictsUnavailable = modelLayers.conflictsUnavailable;
    enhancedData.runState = modelLayers.runState;

    // Success path: Persist a copy of the enhanced train status to disk cache
    if (enhancedData) {
      try {
        const trainFile = path.join(FALLBACK_DIR, `train_${trainNumber}_live_fallback.json`);
        // The conflict block is DERIVED from the delay that was live at this
        // instant, so it must not be persisted. If it were, the fallback path
        // would re-serve a prediction computed against a delay that is no longer
        // current — meets at the wrong km, against the wrong train, with nothing
        // in the payload saying so. It is recomputed on read instead, from the
        // fallback's own delayMinutes, at no upstream cost. `conflictsUnavailable`
        // is dropped for the same reason: the model may be back by then.
        //
        // `runState` is stripped for exactly the same reason (VERIFIED #21): it is
        // derived from a SERVICE DATE, so a persisted "runs today" is wrong the
        // moment the file outlives the day it was written — and "not running
        // today" is the one answer a user would act on. Recomputed on read below.
        const { conflicts, conflictsUnavailable, runState, ...persistable } = enhancedData;

        // FOURTH derived block (VERIFIED #29: "when a third derived block appears,
        // add it to the same strip list"). The hazard layer is computed from the
        // hazard STORE, which a human mutates by approving or rejecting a report, so
        // a persisted copy could re-serve a speed restriction that has since been
        // rejected. Worse than the conflict case: that one merely goes stale, this
        // one can contradict an operator's explicit decision.
        //
        // The hazard minutes do not sit in one strippable field — they fan out into
        // `totals.predicted_eta_min`, `gap_vs_schedule_min`, `predicted_arrival`,
        // `comparison` and every `segment_eta_min`. Unpicking those individually is
        // exactly the kind of arithmetic that goes quietly wrong, and a half-stripped
        // payload would persist an ETA that still contains hazard minutes with
        // nothing left in the file naming them. So the WHOLE `curvatureEta` block
        // goes, unconditionally, with no arithmetic at all.
        //
        // Dropping it costs almost nothing, and this is the part worth checking
        // rather than assuming: the fallback READ path (below, ~line 649) already
        // re-requests `/eta/{train}` from the model and overwrites `curvatureEta`
        // outright. The persisted copy was only ever a remnant that a *failed*
        // recompute could leave standing — which is precisely the case that must
        // not serve hazard minutes. When the model is down the reader now gets an
        // explicit `curvatureEtaUnavailable`, which is the honest answer.
        //
        // Not "skip the write": that would freeze position, delay, stations and
        // tunnels too, so one opt-in request would stale the entire offline
        // fallback. Losing a recomputable ETA is strictly cheaper.
        if (persistable.curvatureEta?.hazard_layer?.enabled) {
          delete persistable.curvatureEta;
          persistable.curvatureEtaUnavailable = {
            reason: 'stripped-hazard-derived',
            detail: 'The ETA on this request included the crowdsourced hazard layer, '
                  + 'which is derived from a store a controller can change. It is '
                  + 'recomputed on read rather than persisted (VERIFIED #21/#29).',
            modelReachable: true,
          };
        }
        fs.writeFileSync(trainFile, JSON.stringify(persistable, null, 2), 'utf-8');
      } catch (writeErr) {
        console.error(`[Controller] Failed to write disk fallback for train #${trainNumber}:`, writeErr.message);
      }

      // Stamp the degradation flags on the SUCCESS path too, so they are ALWAYS present.
      // Previously they were set only when the fallback fired, which meant an absent
      // `is_cached_fallback` was ambiguous: it could mean "genuinely live" or "this code
      // path never set it". The front end had no way to tell those apart, so it could not
      // safely claim a position was live. Now absence is impossible on this route and
      // `false` is a real assertion.
      //
      // Deliberately stamped AFTER the disk write above: JSON.stringify already ran, so the
      // persisted copy does not carry is_cached_fallback:false. That matters — the moment
      // that file is re-served it *is* a fallback, and a stale `false` baked into it would
      // be a live-data claim we can't back up. (Inside this guard, not after it, so a null
      // payload can never turn a successful fetch into a thrown TypeError and divert into
      // the fallback branch below.)
      enhancedData.is_cached_fallback = false;
      enhancedData.rate_limit_active = false;
    }

    res.json({
      success: true,
      trainNumber,
      data: enhancedData,
    });
  } catch (error) {
    // ── Last-resort insurance, NOT a cache layer ──
    // Live responses are no longer cached (config.cache.liveTtl = 0, bypassed entirely), so
    // this branch can no longer fire merely because a TTL lapsed. It fires only when upstream
    // genuinely failed: a 429 burst, a timeout, or no network. Keep it — a blank map during
    // the 1 Sep demo is worse than a clearly-labelled stale one.
    // Every response it produces is explicitly labelled (is_cached_fallback /
    // recovered_from_disk / rate_limit_active) so the UI can say "last known position,
    // fetched at <time>" rather than implying a live GPS fix. Do not remove the labels to
    // make the map look cleaner; that turns insurance into a false liveness claim.
    console.warn(`[Controller] Upstream live status call failed for train #${trainNumber}: ${error.message}. Checking cache...`);

    // 1. Check in-memory cache keys first.
    //    NOTE: with live caching disabled these keys are never populated any more, so in
    //    practice this loop no-ops and the disk copy below is the insurance that actually
    //    fires. Left in place because it costs nothing and still works if CACHE_TTL_LIVE is
    //    deliberately set back to a non-zero value (e.g. to rehearse offline).
    const baseUri = `/api/trains/${trainNumber}/live`;
    const cacheKeys = [
      `__cache__${baseUri}?geometry=true&geometry_format=geojson`,
      `__cache__${baseUri}?geometry=true&geometry_format=geojson&refresh=true`,
      `__cache__${baseUri}`,
    ];

    for (const key of cacheKeys) {
      const cached = cache.get(key);
      if (cached && (cached.data || cached.success)) {
        console.log(`[Controller] Recovered in-memory cached status from key "${key}" for train #${trainNumber}`);
        const payload = cached.data || cached;
        payload.is_cached_fallback = true;
        payload.rate_limit_active = (error.status === 429 || error.response?.status === 429);
        return res.json({
          success: true,
          trainNumber,
          data: payload,
        });
      }
    }

    // 2. Check disk-persisted fallback copies next (the branch that actually fires now that
    //    live caching is off — it also survives a server restart, which node-cache does not).
    //    We check multiple naming variations in the .cache folder
    let fallbackDataRaw = null;
    let fallbackPath = '';

    const pathsToCheck = [
      path.join(FALLBACK_DIR, `train_${trainNumber}_live_fallback.json`),
      path.join(FALLBACK_DIR, `${trainNumber}_live.json`),
    ];

    // Also look for dated runs (e.g. 22229_live_2026-08-28.json)
    try {
      const files = fs.readdirSync(FALLBACK_DIR);
      const datedFiles = files
        .filter(f => f.startsWith(`${trainNumber}_live_`) && f.endsWith('.json'))
        .sort(); // latest date will be last
      if (datedFiles.length > 0) {
        pathsToCheck.push(path.join(FALLBACK_DIR, datedFiles[datedFiles.length - 1]));
      }
    } catch (dirErr) {
      console.warn('[Controller] Failed to read fallback dir:', dirErr.message);
    }

    for (const fpath of pathsToCheck) {
      if (fs.existsSync(fpath)) {
        try {
          fallbackDataRaw = JSON.parse(fs.readFileSync(fpath, 'utf-8'));
          fallbackPath = fpath;
          break; // found one!
        } catch (e) {
          console.warn(`[Controller] Failed to parse fallback at ${fpath}:`, e.message);
        }
      }
    }

    if (fallbackDataRaw) {
      console.log(`[Controller] Recovered disk-persisted cached status from ${fallbackPath} for train #${trainNumber}`);
      
      const liveData = fallbackDataRaw.data?.data || fallbackDataRaw.data || fallbackDataRaw;
      
      // Attempt to load route geometry for DR enhancement
      let routeGeoJson = null;
      const routePath = path.join(FALLBACK_DIR, `${trainNumber}_route.json`);
      if (fs.existsSync(routePath)) {
        try {
          routeGeoJson = JSON.parse(fs.readFileSync(routePath, 'utf-8'));
        } catch (e) {}
      }

      // Apply DR and curvature engine processing on the fallback data
      const enhancedData = enhanceLiveData(liveData, routeGeoJson);
      enhancedData.is_cached_fallback = true;
      enhancedData.recovered_from_disk = true;
      enhancedData.rate_limit_active = (error.status === 429 || error.response?.status === 429);
      enhancedData.liveVelocity = liveVelocityTracker.fallbackVelocity(
        trainNumber,
        liveData.currentLocation?.speedToNextStationKmph || liveData.currentLocation?.speedKmh || liveData.train?.avgSpeed || null
      );
      delete enhancedData.curvatureEta;
      delete enhancedData.curvatureEtaUnavailable;
      delete enhancedData.conflicts;
      delete enhancedData.conflictsUnavailable;
      delete enhancedData.runState;

      const modelLayers = await attachModelLayers(trainNumber, liveData, req, true);
      enhancedData.weather = modelLayers.weather;
      if (modelLayers.curvatureEta) enhancedData.curvatureEta = modelLayers.curvatureEta;
      if (modelLayers.curvatureEtaUnavailable) enhancedData.curvatureEtaUnavailable = modelLayers.curvatureEtaUnavailable;
      if (modelLayers.conflicts) enhancedData.conflicts = modelLayers.conflicts;
      if (modelLayers.conflictsUnavailable) enhancedData.conflictsUnavailable = modelLayers.conflictsUnavailable;
      enhancedData.runState = modelLayers.runState;

      return res.json({
        success: true,
        trainNumber,
        data: enhancedData,
      });
    }
    
    // No cache found: propagate the error
    next(error);
  }
};

export const getCorridorConflicts = async (req, res) => {
  try {
    // Every predicted meet on the corridor for one service date, from the model
    // API's /corridor/conflicts. Pure passthrough — the gateway does no conflict
    // arithmetic of its own, the same discipline the tunnel and per-train
    // conflict layers follow, so the two can never disagree about a meet.
    //
    // Costs ZERO upstream RailRadar requests: meets fall out of two cached
    // timetables (VERIFIED #15). That is what makes a corridor-wide layer
    // affordable at all — polling 206 trains would be impossible against a
    // 10 req/min ceiling.
    const { date, at, window, limit, delay, live_delays, feedback } = req.query;
    const params = {};
    for (const [k, v] of Object.entries({ date, at, window, limit, delay, live_delays, feedback })) {
      if (v !== undefined && v !== '') params[k] = v;
    }
    const upstream = await axios.get(
      `${config.modelApi.baseUrl}/corridor/conflicts`,
      { params, timeout: config.modelApi.corridorTimeoutMs }
    );
    res.json({ success: true, data: upstream.data });
  } catch (error) {
    // Additive layer: a failure here must not break the map. Report the reason
    // rather than an empty list — "no meets predicted" and "the sweep did not
    // run" look identical on a map and mean opposite things (VERIFIED #9).
    const status = error.response?.status;
    if (status === 422) {
      return res.status(422).json({
        success: false,
        reason: 'invalid-parameters',
        detail: error.response.data?.detail || null,
      });
    }
    res.status(503).json({
      success: false,
      reason: 'model-unreachable',
      detail: error.message,
      hint: 'start the ETA model: python3 run_server.py 8000',
    });
  }
};

export const getTunnels = async (req, res, next) => {
  try {
    const zones = getTunnelZones();
    res.json({
      success: true,
      data: zones,
    });
  } catch (error) {
    next(error);
  }
};

export const getTrainRoute = async (req, res, next) => {
  try {
    const { trainNumber } = req.params;
    if (!trainNumber) {
      return res.status(400).json({ success: false, message: 'Train number is required.' });
    }
    const data = await railRadarService.getTrainRoute(trainNumber);
    res.json({
      success: true,
      trainNumber,
      data,
    });
  } catch (error) {
    next(error);
  }
};

export const getTrainCoaches = async (req, res, next) => {
  try {
    const { trainNumber } = req.params;
    if (!trainNumber) {
      return res.status(400).json({ success: false, message: 'Train number is required.' });
    }
    const data = await railRadarService.getTrainCoaches(trainNumber);
    res.json({
      success: true,
      trainNumber,
      data,
    });
  } catch (error) {
    next(error);
  }
};

export const searchTrains = async (req, res, next) => {
  try {
    const query = req.query.q || req.query.query || req.query.search;
    if (!query) {
      return res.status(400).json({
        success: false,
        message: 'Search query is required. Provide ?q=12002 or ?q=Shatabdi',
      });
    }
    const data = await railRadarService.searchTrains(query);
    res.json({
      success: true,
      query,
      data,
    });
  } catch (error) {
    next(error);
  }
};

export const getTrainCategories = async (req, res, next) => {
  try {
    const data = await railRadarService.getTrainCategories();
    res.json({
      success: true,
      data,
    });
  } catch (error) {
    next(error);
  }
};

export const getLiveFleet = async (req, res, next) => {
  try {
    const data = await railRadarService.getLiveFleet();
    
    // If the fleet fetch returned 0 trains (upstream refused every request, or the quota
    // guard is holding the line), fall back to the last successfully cached fleet copy so the
    // dashboard doesn't go blank. Insurance only — with live caching disabled this cannot
    // fire from a lapsed TTL, only from genuine upstream failure — and every branch below
    // labels its response is_cached_fallback:true so the UI can mark the markers as stale.
    if (!data || !data.fleet || data.fleet.length === 0) {
      console.warn('[LiveFleet Controller] Upstream returned empty fleet. Fetching fallback cache...');
      
      // 1. Try In-Memory Cache first
      const cacheKeys = [
        '__cache__/api/trains/radar/fleet',
        '__cache__/api/trains/radar/fleet?refresh=true',
      ];
      for (const key of cacheKeys) {
        const cached = cache.get(key);
        const cachedFleet = cached?.data?.fleet || cached?.fleet;
        if (cachedFleet && cachedFleet.length > 0) {
          console.log(`[LiveFleet Controller] Recovered in-memory cached fleet from key "${key}"`);
          // Recomputed, never re-served: the cached copy's run-state (if any) was
          // computed on the day it was cached (VERIFIED #21).
          await attachFleetRunStates(cachedFleet);
          return res.json({
            success: true,
            data: {
              count: cachedFleet.length,
              timestamp: cached?.data?.timestamp || cached?.timestamp || new Date().toISOString(),
              fleet: cachedFleet,
              is_cached_fallback: true,
              // Why the LIVE attempt produced nothing. Without this the fallback is
              // indistinguishable from success and a persistent live failure hides
              // behind slightly-old positions.
              live_failures: data?.failures || [],
              requested: data?.requested ?? null,
            }
          });
        }
      }

      // 2. Try Disk Fallback Cache next (survives server restarts)
      if (fs.existsSync(FALLBACK_FILE)) {
        try {
          const diskPayload = JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf-8'));
          if (diskPayload && diskPayload.fleet && diskPayload.fleet.length > 0) {
            console.log(`[LiveFleet Controller] Recovered disk-persisted cached fleet from ${FALLBACK_FILE}`);
            // Same as the in-memory branch: recompute against today's date rather
            // than trusting whatever day the file was written (VERIFIED #21).
            await attachFleetRunStates(diskPayload.fleet);
            return res.json({
              success: true,
              data: {
                count: diskPayload.fleet.length,
                timestamp: diskPayload.timestamp || new Date().toISOString(),
                fleet: diskPayload.fleet,
                is_cached_fallback: true,
                recovered_from_disk: true,
                // See the in-memory branch: the live attempt's failure reasons must
                // travel with the fallback, or the fallback looks like success.
                live_failures: data?.failures || [],
                requested: data?.requested ?? null,
              }
            });
          }
        } catch (readErr) {
          console.error('[LiveFleet Controller] Failed to read disk fallback:', readErr.message);
        }
      }
    }

    // Success path: Persist a copy to disk cache
    if (data && data.fleet && data.fleet.length > 0) {
      try {
        fs.writeFileSync(FALLBACK_FILE, JSON.stringify(data, null, 2), 'utf-8');
      } catch (writeErr) {
        console.error('[LiveFleet Controller] Failed to write fallback file to disk:', writeErr.message);
      }
    }

    // Symmetry with getTrainLiveStatus: an absent is_cached_fallback must never be the only
    // evidence that the fleet is live, so assert it explicitly. Stamped after the disk write
    // for the same reason as there — the persisted copy is a fallback by definition and must
    // not carry a baked-in `false`.
    // An empty-but-live fleet legitimately reaches here with false: that is honest (upstream
    // answered, nothing is running), and distinct from serving yesterday's positions.
    if (data) {
      data.is_cached_fallback = false;
    }

    // After the disk write, exactly like `is_cached_fallback` above and for the
    // same reason: run-state is derived from today's date and must not be baked
    // into the persisted copy (VERIFIED #21).
    if (data && Array.isArray(data.fleet)) {
      await attachFleetRunStates(data.fleet);
    }

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    next(error);
  }
};

export const proxyPass = async (req, res, next) => {
  try {
    // subpath extracted from wildcard
    const subpath = req.params[0] || '';
    if (!subpath) {
      return res.status(400).json({
        success: false,
        message: 'Wildcard subpath is missing. Example: /api/proxy/trains/12002/live',
      });
    }
    const data = await railRadarService.proxyRequest(subpath, req.method, req.query, req.body);
    res.json({
      success: true,
      path: subpath,
      data,
    });
  } catch (error) {
    next(error);
  }
};
