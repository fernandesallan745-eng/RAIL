import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
//  TUNNEL & BLIND-SPOT ETA ENGINE  (Dead Reckoning v1)
// ============================================================
//
//  When RTIS/GPS drops inside tunnels or blind spots, this
//  engine interpolates position along the known route polyline
//  using last-known speed + tunnel-specific historical speed.
//  On signal return it recalibrates via exponential moving
//  average, so accuracy improves with every passage.
// ============================================================

// --- Config ---
const STALE_THRESHOLD_MS = 3 * 60 * 1000;   // 3 minutes
const PROXIMITY_KM       = 15;              // how close to a tunnel entry to trigger zone match
const EMA_ALPHA           = 0.3;            // recalibration smoothing factor

// --- Load tunnel zones ---
const TUNNEL_ZONES_PATH   = path.join(__dirname, '../data/tunnel-zones.json');
const SPEED_HISTORY_PATH  = path.join(__dirname, '../data/speed-history.json');

let tunnelZones = [];
let speedHistory = { _meta: { alpha: EMA_ALPHA, lastUpdated: null }, zones: {} };

try {
  tunnelZones = JSON.parse(fs.readFileSync(TUNNEL_ZONES_PATH, 'utf-8'));
} catch (err) {
  console.warn('[DeadReckoning] Could not load tunnel-zones.json:', err.message);
}

try {
  speedHistory = JSON.parse(fs.readFileSync(SPEED_HISTORY_PATH, 'utf-8'));
} catch {
  // Will be created on first recalibration
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

/** Get historical speed for a zone (recalibrated or default) */
function getZoneSpeed(zone) {
  if (speedHistory.zones[zone.id] && speedHistory.zones[zone.id].avgSpeedKmph) {
    return speedHistory.zones[zone.id].avgSpeedKmph;
  }
  return zone.historicalAvgSpeedKmph || 40;
}

// ============================================================
//  CORE DETECTION
// ============================================================

/**
 * Detect if a train is currently in a blind spot / tunnel.
 *
 * @param {Object} liveData - raw live status from RailRadar
 * @returns {{ inBlindSpot: boolean, zone: Object|null, staleSinceMs: number }}
 */
export function detectBlindSpot(liveData) {
  if (!liveData) return { inBlindSpot: false, zone: null, staleSinceMs: 0 };

  const status = liveData.status;
  if (status !== 'running') return { inBlindSpot: false, zone: null, staleSinceMs: 0 };

  // Check staleness
  const lastUpdated = liveData.lastUpdatedAt || liveData.lastUpdated;
  if (!lastUpdated) return { inBlindSpot: false, zone: null, staleSinceMs: 0 };

  const staleSinceMs = Date.now() - new Date(lastUpdated).getTime();
  if (staleSinceMs < STALE_THRESHOLD_MS) {
    return { inBlindSpot: false, zone: null, staleSinceMs };
  }

  // Signal is stale. Check proximity to any known tunnel zone.
  const currentLoc = liveData.currentLocation || {};
  let trainLat = currentLoc.lat;
  let trainLng = currentLoc.lng;

  // Fallback: derive from route if location has no coords
  if (trainLat == null || trainLng == null) {
    const route = liveData.route || [];
    const seq = currentLoc.sequence;
    if (seq != null) {
      const matchStation = route.find(s => s.sequence === seq);
      if (matchStation) {
        trainLat = matchStation.lat || (matchStation.station && matchStation.station.lat);
        trainLng = matchStation.lng || (matchStation.station && matchStation.station.lng);
      }
    }
    // Still nothing — try train source
    if (trainLat == null) {
      const trainInfo = liveData.train || {};
      trainLat = trainInfo.source?.lat;
      trainLng = trainInfo.source?.lng;
    }
  }

  if (trainLat == null || trainLng == null) {
    // Can't locate the train at all — still report stale but no zone
    return { inBlindSpot: true, zone: null, staleSinceMs };
  }

  // Find nearest tunnel zone
  let nearestZone = null;
  let nearestDist = Infinity;

  for (const zone of tunnelZones) {
    const distEntry = haversineKm(trainLat, trainLng, zone.entryLat, zone.entryLng);
    const distExit  = haversineKm(trainLat, trainLng, zone.exitLat, zone.exitLng);
    const minDist = Math.min(distEntry, distExit);

    if (minDist < PROXIMITY_KM && minDist < nearestDist) {
      nearestDist = minDist;
      nearestZone = zone;
    }
  }

  return {
    inBlindSpot: true,
    zone: nearestZone,
    staleSinceMs,
    proximityKm: nearestDist === Infinity ? null : Math.round(nearestDist * 10) / 10,
  };
}

// ============================================================
//  POSITION INTERPOLATION
// ============================================================

/**
 * Dead-reckon the train's estimated position.
 *
 * @param {Object} liveData     – raw live status
 * @param {Object} routeGeoJson – route geometry (optional, for polyline interpolation)
 * @param {Object} zone         – matched tunnel zone (or null)
 * @param {number} staleSinceMs – how long signal has been stale
 * @returns {{ lat, lng, distanceFromEntryKm, confidence }}
 */
export function interpolatePosition(liveData, routeGeoJson, zone, staleSinceMs) {
  const currentLoc = liveData.currentLocation || {};
  const trainInfo = liveData.train || {};
  const route = liveData.route || [];

  // Determine speed to use
  let speedKmph;
  if (zone) {
    speedKmph = getZoneSpeed(zone);
  } else {
    // Use last known speed, or train's average speed
    speedKmph = currentLoc.speedToNextStationKmph || trainInfo.avgSpeed || 50;
  }

  const elapsedHours = staleSinceMs / (1000 * 60 * 60);
  const estimatedDistanceKm = speedKmph * elapsedHours;

  // Starting point: the last known distance from origin
  const lastKnownDistKm = currentLoc.distanceFromOriginKm ||
    distanceToSequence(route, currentLoc.sequence) ||
    0;
  const totalDistKm = lastKnownDistKm + estimatedDistanceKm;

  // Try to interpolate along route GeoJSON polyline
  let estimatedPos = null;

  if (routeGeoJson && routeGeoJson.geometry && routeGeoJson.geometry.coordinates) {
    const coords = routeGeoJson.geometry.coordinates.map(c => [c[1], c[0]]); // [lat, lng]
    estimatedPos = interpolateAlongPolyline(coords, totalDistKm);
  }

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

  // Boost confidence if we matched a known tunnel zone
  if (zone) {
    confidence = Math.min(0.98, confidence + 0.1);
  }
  confidence = Math.round(confidence * 100) / 100;

  return {
    lat: estimatedPos?.lat || currentLoc.lat || trainInfo.source?.lat,
    lng: estimatedPos?.lng || currentLoc.lng || trainInfo.source?.lng,
    distanceFromEntryKm: Math.round(estimatedDistanceKm * 10) / 10,
    totalDistFromOriginKm: Math.round(totalDistKm * 10) / 10,
    speedUsedKmph: Math.round(speedKmph),
    confidence,
  };
}

// ============================================================
//  ETA CALCULATION
// ============================================================

/**
 * Calculate estimated time of arrival at the next halt.
 */
export function calculateETA(liveData, estimatedPos, zone) {
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

  let remainingKm = 0;
  if (nextHaltStation && nextHaltStation.distance != null && estimatedPos.totalDistFromOriginKm) {
    remainingKm = Math.max(0, nextHaltStation.distance - estimatedPos.totalDistFromOriginKm);
  } else if (nextHalt.distance != null && estimatedPos.totalDistFromOriginKm) {
    remainingKm = Math.max(0, nextHalt.distance - estimatedPos.totalDistFromOriginKm);
  } else {
    remainingKm = 20; // rough fallback
  }

  const speedKmph = zone ? getZoneSpeed(zone) : (trainInfo.avgSpeed || 50);
  const etaMinutes = Math.round((remainingKm / speedKmph) * 60);

  const etaDate = new Date(Date.now() + etaMinutes * 60000);

  return {
    stationName: nextHalt.stationName || nextHalt.stationCode,
    stationCode: nextHalt.stationCode,
    remainingKm: Math.round(remainingKm * 10) / 10,
    estimatedMinutes: etaMinutes,
    estimatedArrival: etaDate.toISOString(),
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
 * Enhance raw RailRadar live data with dead reckoning fields.
 * Call this AFTER fetching from the RailRadar API, BEFORE
 * returning to the client.
 *
 * @param {Object} liveData     – raw live data from API
 * @param {Object} routeGeoJson – route geometry (optional)
 * @returns {Object} – liveData augmented with `deadReckoning` block
 */
export function enhanceLiveData(liveData, routeGeoJson = null) {
  if (!liveData) return liveData;

  const detection = detectBlindSpot(liveData);

  if (!detection.inBlindSpot) {
    // Signal is fresh. Check if we need to recalibrate a previous blind spot.
    // (Recalibration is handled by tracking state across requests — for V1
    //  we annotate the response so the client can track and trigger it.)
    liveData.deadReckoning = {
      active: false,
      staleSinceMs: detection.staleSinceMs,
      method: 'live_signal',
    };
    return liveData;
  }

  // --- Blind Spot Detected: Dead Reckoning ---
  const estimatedPos = interpolatePosition(
    liveData, routeGeoJson, detection.zone, detection.staleSinceMs
  );

  const eta = calculateETA(liveData, estimatedPos, detection.zone);

  liveData.deadReckoning = {
    active: true,
    reason: detection.zone ? 'tunnel_zone' : 'signal_stale',
    staleSinceMs: detection.staleSinceMs,
    lastSignalAt: liveData.lastUpdatedAt || liveData.lastUpdated,
    tunnelZone: detection.zone ? {
      id: detection.zone.id,
      name: detection.zone.name,
      route: detection.zone.route,
      lengthKm: detection.zone.lengthKm,
      entryLat: detection.zone.entryLat,
      entryLng: detection.zone.entryLng,
      exitLat: detection.zone.exitLat,
      exitLng: detection.zone.exitLng,
      signalDropProbability: detection.zone.signalDropProbability,
      proximityKm: detection.proximityKm,
    } : null,
    estimatedPosition: {
      lat: estimatedPos.lat,
      lng: estimatedPos.lng,
      distanceFromEntryKm: estimatedPos.distanceFromEntryKm,
      totalDistFromOriginKm: estimatedPos.totalDistFromOriginKm,
      confidence: estimatedPos.confidence,
    },
    etaNextHalt: eta,
    method: 'dead_reckoning_v1',
    historicalAvgSpeedKmph: estimatedPos.speedUsedKmph,
  };

  return liveData;
}

// ============================================================
//  EXPORTS FOR API
// ============================================================

/** Return the full tunnel zones database (for frontend overlay) */
export function getTunnelZones() {
  return tunnelZones.map(z => ({
    ...z,
    currentHistoricalSpeed: getZoneSpeed(z),
    recalibrationData: speedHistory.zones[z.id] || null,
  }));
}

/** Return recalibration history stats */
export function getSpeedHistory() {
  return speedHistory;
}
