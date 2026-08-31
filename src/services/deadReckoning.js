import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  projectTunnelsOntoRoute,
  findTunnelState,
  blockSpeedAtKm,
  tunnelCoverage,
  tunnelMeta,
  rawTunnels,
} from './tunnels.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
//  TUNNEL & BLIND-SPOT ETA ENGINE  (Dead Reckoning v1)
// ============================================================
//
//  When GPS drops inside a tunnel, this engine answers "which tunnel are we in,
//  and how long until we come out" from the train's distance-from-origin and a
//  database of 69 real Konkan tunnel portals (src/data/konkan-tunnels.json,
//  built by build_tunnels.py from OpenStreetMap way geometry).
//
//  TWO THINGS THAT CHANGED FROM v0, both of which were wrong:
//
//  1. Tunnel identity is CONTAINMENT, not proximity. v0 matched the nearest
//     tunnel within 15 km. With 69 tunnels whose MEDIAN length is 593 m, a
//     15 km radius contains dozens of them — it would routinely name a
//     neighbour with total confidence. Now: entryKm <= position <= exitKm.
//
//  2. Tunnel state is computed on EVERY poll, not only once GPS goes stale.
//     "Which tunnel am I about to enter" is useful before the signal drops;
//     dead reckoning still waits for staleness, but identity does not.
//
//  HONESTY: there is no live speed anywhere in this data source (CLAUDE.md
//  VERIFIED #3). Time-to-exit uses the schedule-derived block speed and every
//  such number carries its basis label. Do not relabel it as GPS speed.
// ============================================================

// --- Config ---
const STALE_THRESHOLD_MS = 3 * 60 * 1000;   // 3 minutes
const EMA_ALPHA           = 0.3;            // recalibration smoothing factor

const SPEED_HISTORY_PATH  = path.join(__dirname, '../data/speed-history.json');

let speedHistory = { _meta: { alpha: EMA_ALPHA, lastUpdated: null }, zones: {} };

try {
  speedHistory = JSON.parse(fs.readFileSync(SPEED_HISTORY_PATH, 'utf-8'));
} catch {
  // Will be created on first recalibration
}

// Projection is a pure function of (polyline, route) and both are immutable for
// a run, so it is memoised per train — the 69x2 portal projections run once, not
// on every poll.
const projectionCache = new Map(); // trainNumber → projectTunnelsOntoRoute result

/**
 * Pull [[lat,lng], ...] out of whichever shape the geometry arrived in.
 * RailRadar nests an extra `geojson` wrapper (CLAUDE.md VERIFIED #1) and the
 * route endpoint, the live endpoint and the disk fallback each expose it at a
 * slightly different depth.
 */
function extractCoords(source) {
  if (!source) return null;
  const candidates = [
    source?.geojson?.geometry?.coordinates,
    source?.geometry?.geojson?.geometry?.coordinates,
    source?.data?.geojson?.geometry?.coordinates,
    source?.geometry?.coordinates,
    source?.data?.geometry?.coordinates,
    source?.coordinates,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 1 && Array.isArray(c[0])) {
      // GeoJSON is [lng, lat]
      return c.map((p) => [p[1], p[0]]);
    }
  }
  return null;
}

/** Projected tunnels for a train, computed once and reused. */
function getProjection(trainNumber, liveData, routeGeoJson) {
  const key = String(trainNumber || liveData?.trainNumber || 'unknown');
  const cached = projectionCache.get(key);
  // Re-project if the cached run had no station anchors but this payload does —
  // that is the difference between a caveated global-scale fit and a real one.
  const route = liveData?.route || [];
  const hasCoords = route.some((s) => (s.lat ?? s.station?.lat) != null);
  if (cached && !(cached.axisBasis === 'global-scale' && hasCoords)) return cached;

  const coords = extractCoords(routeGeoJson) || extractCoords(liveData?.geometry);
  if (!coords) return null;

  const result = projectTunnelsOntoRoute(coords, route, liveData?.train?.distance ?? null);
  projectionCache.set(key, result);
  return result;
}

// ============================================================
//  HELPERS
// ============================================================

/** Haversine distance in km between two lat/lng pairs */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Walk `targetKm` along an array of [lat, lng] coordinates.
 * Returns the interpolated point { lat, lng, segmentIndex }.
 */
function interpolateAlongPolyline(coords, targetKm) {
  if (!coords || coords.length < 2) return null;

  let accumulated = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const segLen = haversineKm(
      coords[i][0], coords[i][1],
      coords[i + 1][0], coords[i + 1][1]
    );
    if (accumulated + segLen >= targetKm) {
      // Interpolate within this segment
      const remaining = targetKm - accumulated;
      const ratio = segLen > 0 ? remaining / segLen : 0;
      return {
        lat: coords[i][0] + (coords[i + 1][0] - coords[i][0]) * ratio,
        lng: coords[i][1] + (coords[i + 1][1] - coords[i][1]) * ratio,
        segmentIndex: i,
      };
    }
    accumulated += segLen;
  }
  // Past the end — return last point
  const last = coords[coords.length - 1];
  return { lat: last[0], lng: last[1], segmentIndex: coords.length - 2 };
}

/**
 * Find cumulative distance from route start to a given station sequence
 * in the route array. Falls back to the station's own `distance` field.
 */
function distanceToSequence(route, sequence) {
  const station = route.find(s => s.sequence === sequence);
  if (station && station.distance != null) return station.distance;
  return null;
}

/** Build a flat [lat, lng] coordinate array from the route stations */
function routeToCoords(route) {
  return route
    .filter(s => {
      const lat = s.lat || (s.station && s.station.lat);
      return lat != null;
    })
    .map(s => [
      s.lat || s.station.lat,
      s.lng || s.station.lng,
    ]);
}

/**
 * Speed to use inside a tunnel, with its provenance attached.
 *
 * Order of preference:
 *   1. an EMA-recalibrated observed speed for this tunnel, if one exists
 *   2. the schedule-derived block speed passed in by the caller
 *
 * There is deliberately NO invented constant fallback. v0 returned 40 km/h when
 * it knew nothing, which is indistinguishable in the UI from a measured number.
 * If neither source exists this returns null and the UI shows no time-to-exit.
 */
function getZoneSpeed(tunnelId, blockSpeed) {
  const observed = tunnelId ? speedHistory.zones?.[tunnelId] : null;
  if (observed?.avgSpeedKmph) {
    return {
      speedKmph: observed.avgSpeedKmph,
      basis: 'observed-ema',
      basisLabel: `recalibrated from ${observed.sampleCount || 1} observed passage(s)`,
    };
  }
  if (blockSpeed?.speedKmph) return blockSpeed;
  return null;
}

// ============================================================
//  CORE DETECTION
// ============================================================

/**
 * Where is the train relative to the tunnel database, and is its signal stale?
 *
 * Tunnel identity comes from CHAINAGE CONTAINMENT and is computed whether or not
 * the signal is stale. Only `inBlindSpot` depends on staleness.
 *
 * @param {Object} liveData    - raw live status from RailRadar
 * @param {Object} projection  - projectTunnelsOntoRoute() result, or null
 * @returns {{ inBlindSpot, tunnelState, staleSinceMs, blockSpeed }}
 */
export function detectBlindSpot(liveData, projection = null) {
  const empty = {
    inBlindSpot: false,
    tunnelState: null,
    staleSinceMs: 0,
    blockSpeed: null,
  };
  if (!liveData) return empty;

  const lastUpdated = liveData.lastUpdatedAt || liveData.lastUpdated;
  const staleSinceMs = lastUpdated
    ? Date.now() - new Date(lastUpdated).getTime()
    : 0;

  const route = liveData.route || [];
  const km = liveData.currentLocation?.distanceFromOriginKm;

  let tunnelState = null;
  let blockSpeed = null;
  if (projection?.tunnels?.length && km != null) {
    blockSpeed = blockSpeedAtKm(route, km);
    const insideId = projection.tunnels.find(
      (t) => km >= t.entryKm && km <= t.exitKm
    )?.id;
    tunnelState = findTunnelState(
      projection.tunnels,
      km,
      getZoneSpeed(insideId, blockSpeed)
    );
  }

  // Dead reckoning engages only when the signal has actually gone quiet AND the
  // train is running. Being inside a tunnel is neither necessary nor sufficient:
  // a stale signal in open country is still a blind spot, and a tunnel with a
  // fresh position needs no reckoning.
  const running = liveData.status === 'running';
  const inBlindSpot = running && staleSinceMs >= STALE_THRESHOLD_MS;

  return { inBlindSpot, tunnelState, staleSinceMs, blockSpeed };
}

// ============================================================
//  POSITION INTERPOLATION
// ============================================================

/**
 * Dead-reckon the train's estimated position.
 *
 * @param {Object} liveData     – raw live status
 * @param {Object} routeGeoJson – route geometry (optional, for polyline interpolation)
 * @param {Object} speed        – { speedKmph, basis, basisLabel } or null
 * @param {number} staleSinceMs – how long signal has been stale
 * @returns {{ lat, lng, distanceFromEntryKm, confidence }}
 */
export function interpolatePosition(liveData, routeGeoJson, speed, staleSinceMs) {
  const currentLoc = liveData.currentLocation || {};
  const trainInfo = liveData.train || {};
  const route = liveData.route || [];

  // Every candidate here is schedule-derived or a static journey mean; none is a
  // live speedometer reading (CLAUDE.md VERIFIED #3). The basis label rides along
  // so the UI can say which one it used.
  let speedKmph = speed?.speedKmph;
  let speedBasis = speed?.basis;
  if (!speedKmph) {
    speedKmph = currentLoc.speedToNextStationKmph || trainInfo.avgSpeed || null;
    speedBasis = currentLoc.speedToNextStationKmph
      ? 'schedule'
      : trainInfo.avgSpeed
      ? 'journey-average'
      : null;
  }

  const elapsedHours = staleSinceMs / (1000 * 60 * 60);
  const estimatedDistanceKm = speedKmph ? speedKmph * elapsedHours : 0;

  // Starting point: the last known distance from origin
  const lastKnownDistKm = currentLoc.distanceFromOriginKm ||
    distanceToSequence(route, currentLoc.sequence) ||
    0;
  const totalDistKm = lastKnownDistKm + estimatedDistanceKm;

  // Try to interpolate along route GeoJSON polyline
  let estimatedPos = null;
  const coords = extractCoords(routeGeoJson) || extractCoords(liveData?.geometry);
  if (coords) estimatedPos = interpolateAlongPolyline(coords, totalDistKm);

  // Fallback: interpolate along route stations
  if (!estimatedPos) {
    const stationCoords = routeToCoords(route);
    if (stationCoords.length >= 2) {
      estimatedPos = interpolateAlongPolyline(stationCoords, totalDistKm);
    }
  }

  // Confidence degrades with time: starts at 0.95, drops ~5% per minute stale
  const staleMinutes = staleSinceMs / 60000;
  let confidence = Math.max(0.15, 0.95 - staleMinutes * 0.05);
  confidence = Math.round(confidence * 100) / 100;

  return {
    lat: estimatedPos?.lat || currentLoc.lat || trainInfo.source?.lat,
    lng: estimatedPos?.lng || currentLoc.lng || trainInfo.source?.lng,
    distanceFromEntryKm: Math.round(estimatedDistanceKm * 10) / 10,
    totalDistFromOriginKm: Math.round(totalDistKm * 10) / 10,
    speedUsedKmph: speedKmph ? Math.round(speedKmph) : null,
    speedBasis,
    confidence,
  };
}

// ============================================================
//  ETA CALCULATION
// ============================================================

/**
 * Calculate estimated time of arrival at the next halt.
 */
export function calculateETA(liveData, estimatedPos, speed) {
  const nextHalt = liveData.nextHalt || {};
  const route = liveData.route || [];
  const trainInfo = liveData.train || {};

  if (!nextHalt.stationName && !nextHalt.stationCode) {
    return null;
  }

  // Distance from estimated position to next halt
  const nextHaltStation = route.find(
    s => s.stationCode === nextHalt.stationCode || s.sequence === nextHalt.sequence
  );

  let remainingKm = null;
  if (nextHaltStation && nextHaltStation.distance != null && estimatedPos.totalDistFromOriginKm) {
    remainingKm = Math.max(0, nextHaltStation.distance - estimatedPos.totalDistFromOriginKm);
  } else if (nextHalt.distance != null && estimatedPos.totalDistFromOriginKm) {
    remainingKm = Math.max(0, nextHalt.distance - estimatedPos.totalDistFromOriginKm);
  }

  const speedKmph = speed?.speedKmph || trainInfo.avgSpeed || null;
  // No invented "rough fallback" distance and no invented speed: if either is
  // unknown, say so rather than printing a confident number built from neither.
  if (remainingKm == null || !speedKmph) {
    return {
      stationName: nextHalt.stationName || nextHalt.stationCode,
      stationCode: nextHalt.stationCode,
      remainingKm: remainingKm == null ? null : Math.round(remainingKm * 10) / 10,
      estimatedMinutes: null,
      estimatedArrival: null,
      unavailableReason: remainingKm == null ? 'no distance to next halt' : 'no speed basis',
      confidence: null,
    };
  }

  const etaMinutes = Math.round((remainingKm / speedKmph) * 60);
  const etaDate = new Date(Date.now() + etaMinutes * 60000);

  return {
    stationName: nextHalt.stationName || nextHalt.stationCode,
    stationCode: nextHalt.stationCode,
    remainingKm: Math.round(remainingKm * 10) / 10,
    estimatedMinutes: etaMinutes,
    estimatedArrival: etaDate.toISOString(),
    speedBasis: speed?.basis || 'journey-average',
    speedBasisLabel: speed?.basisLabel || null,
    confidence: Math.max(0.15, estimatedPos.confidence - 0.05),
  };
}

// ============================================================
//  RECALIBRATION
// ============================================================

/**
 * Recalibrate historical speed for a zone when signal returns.
 * Uses exponential moving average (EMA).
 *
 * @param {string} zoneId         – tunnel zone ID
 * @param {number} transitTimeMs  – actual time spent in blind spot
 * @param {number} transitDistKm  – distance through the zone
 */
export function recalibrate(zoneId, transitTimeMs, transitDistKm) {
  if (!zoneId || transitTimeMs <= 0 || transitDistKm <= 0) return;

  const actualSpeedKmph = (transitDistKm / transitTimeMs) * 3600000;

  // Reject absurd values
  if (actualSpeedKmph < 2 || actualSpeedKmph > 200) return;

  const existing = speedHistory.zones[zoneId];
  let newAvg;

  if (existing && existing.avgSpeedKmph) {
    // EMA: newAvg = α × actual + (1-α) × old
    newAvg = EMA_ALPHA * actualSpeedKmph + (1 - EMA_ALPHA) * existing.avgSpeedKmph;
  } else {
    newAvg = actualSpeedKmph;
  }

  speedHistory.zones[zoneId] = {
    avgSpeedKmph: Math.round(newAvg * 10) / 10,
    lastActualSpeedKmph: Math.round(actualSpeedKmph * 10) / 10,
    sampleCount: (existing?.sampleCount || 0) + 1,
    lastRecalibrated: new Date().toISOString(),
  };

  speedHistory._meta.lastUpdated = new Date().toISOString();

  // Persist to disk (fire-and-forget)
  try {
    fs.writeFileSync(SPEED_HISTORY_PATH, JSON.stringify(speedHistory, null, 2), 'utf-8');
  } catch (err) {
    console.error('[DeadReckoning] Failed to persist speed-history.json:', err.message);
  }

  console.log(
    `[DeadReckoning] Recalibrated zone "${zoneId}": ` +
    `actual=${Math.round(actualSpeedKmph)}km/h → ` +
    `newAvg=${Math.round(newAvg)}km/h (samples: ${speedHistory.zones[zoneId].sampleCount})`
  );

  return speedHistory.zones[zoneId];
}

// ============================================================
//  MAIN ENTRY POINT — enhanceLiveData
// ============================================================

/**
 * Enhance raw RailRadar live data with the tunnel layer and, when the signal has
 * gone quiet, dead reckoning.
 *
 * Two independent blocks are attached:
 *   liveData.tunnels        – always, whenever the route can be projected.
 *                             "Which tunnel am I in / which is next" is useful
 *                             before the signal drops, not only after.
 *   liveData.deadReckoning  – only when the signal is actually stale.
 *
 * @param {Object} liveData     – raw live data from API
 * @param {Object} routeGeoJson – route geometry (optional)
 * @returns {Object} – liveData augmented in place
 */
export function enhanceLiveData(liveData, routeGeoJson = null) {
  if (!liveData) return liveData;

  const projection = getProjection(liveData.trainNumber, liveData, routeGeoJson);
  const detection = detectBlindSpot(liveData, projection);
  const state = detection.tunnelState;

  if (projection) {
    liveData.tunnels = {
      inside: state?.inside || null,
      ahead: state?.ahead || null,
      passedCount: state?.passedCount ?? null,
      totalCount: projection.tunnels.length,
      // The full projected list, so the map can draw every tunnel and not just
      // the one the train is in. ~20 KB, generated from the memoised projection
      // at zero upstream cost — this handler is the single-train drawer, which
      // polls every 30 s; the fleet endpoint never calls enhanceLiveData, so a
      // wider fleet does not multiply this.
      //
      // Sent rather than fetched separately because entryKm/exitKm are
      // train-specific (they are on THIS train's timetable axis), so a static
      // /api/tunnels/zones list could not carry them.
      list: projection.tunnels,
      coverage: tunnelCoverage(projection.tunnels),
      // Axis provenance. 'global-scale' means the route came back without
      // station coordinates, so tunnel chainage is fitted with one scale factor
      // instead of anchored per block — a ~585 m worst-case error, which is
      // longer than the median tunnel. The UI must caveat it.
      axisBasis: projection.axisBasis,
      anchorCount: projection.anchorCount,
      axisMismatchM: projection.axisMismatchM,
      source: tunnelMeta.source || null,
      sourceIsOfficial: tunnelMeta.sourceIsOfficial ?? false,
      caveat: tunnelMeta.uiCaveat || null,
    };
  }

  if (!detection.inBlindSpot) {
    liveData.deadReckoning = {
      active: false,
      staleSinceMs: detection.staleSinceMs,
      method: 'live_signal',
    };
    return liveData;
  }

  // --- Signal has gone quiet: dead-reckon forward ---
  const insideId = state?.inside?.id || null;
  const speed = getZoneSpeed(insideId, detection.blockSpeed);

  const estimatedPos = interpolatePosition(
    liveData, routeGeoJson, speed, detection.staleSinceMs
  );
  const eta = calculateETA(liveData, estimatedPos, speed);

  liveData.deadReckoning = {
    active: true,
    reason: state?.inside ? 'inside_tunnel' : 'signal_stale',
    staleSinceMs: detection.staleSinceMs,
    lastSignalAt: liveData.lastUpdatedAt || liveData.lastUpdated,
    // The tunnel identity is the same object the `tunnels` block reports —
    // one source of truth, so the two panels can never disagree.
    tunnel: state?.inside || null,
    estimatedPosition: {
      lat: estimatedPos.lat,
      lng: estimatedPos.lng,
      distanceFromEntryKm: estimatedPos.distanceFromEntryKm,
      totalDistFromOriginKm: estimatedPos.totalDistFromOriginKm,
      confidence: estimatedPos.confidence,
    },
    etaNextHalt: eta,
    method: 'dead_reckoning_v1',
    speedUsedKmph: estimatedPos.speedUsedKmph,
    speedBasis: estimatedPos.speedBasis,
    speedBasisLabel: speed?.basisLabel || null,
  };

  return liveData;
}

// ============================================================
//  EXPORTS FOR API
// ============================================================

/** The tunnel database as built, plus its provenance metadata. */
export function getTunnelZones() {
  return {
    meta: tunnelMeta,
    coverage: tunnelCoverage(rawTunnels),
    tunnels: rawTunnels.map((t) => ({
      ...t,
      // Only present once a passage has actually been observed. speed-history.json
      // ships empty, so this is null for every tunnel until the EMA path runs for
      // the first time — it has never run.
      recalibrationData: speedHistory.zones?.[t.id] || null,
    })),
  };
}

/** Return recalibration history stats */
export function getSpeedHistory() {
  return speedHistory;
}
