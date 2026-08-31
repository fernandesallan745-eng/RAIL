import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
//  TUNNEL CHAINAGE PROJECTION & CONTAINMENT
// ============================================================
//
//  Answers two questions for the live map:
//    1. Which tunnel is the train inside right now?
//    2. How far / how long until it comes out?
//
//  The hard part is neither of those — it is the AXIS.
//
//  RailRadar's `currentLocation` carries NO lat/lng. The train's position is
//  `distanceFromOriginKm`, measured on the TIMETABLE axis (582.2 km for 12051).
//  Tunnel portals are lat/lng, so their chainage has to be measured on the
//  POLYLINE axis (582.79 km). Those two axes differ by 585 m — which is longer
//  than the MEDIAN TUNNEL on this route (593 m). Comparing them directly would
//  misplace the train by more than a whole typical tunnel.
//
//  So tunnel chainage is renormalised per block onto the timetable axis, using
//  the route's own stations as anchors. This is the same correction
//  eta_model.snap_halts_to_vertices applies to halts, for the same reason (see
//  CLAUDE.md §5 "Geometry alignment", where a single global scale factor smeared
//  a 6.6 km mismatch across all blocks as ±0.5 min of noise).
// ============================================================

const TUNNELS_PATH = path.join(__dirname, '../data/konkan-tunnels.json');

let tunnelDb = { _meta: {}, tunnels: [] };
try {
  tunnelDb = JSON.parse(fs.readFileSync(TUNNELS_PATH, 'utf-8'));
} catch (err) {
  console.warn('[Tunnels] Could not load konkan-tunnels.json:', err.message);
}

export const tunnelMeta = tunnelDb._meta || {};
export const rawTunnels = tunnelDb.tunnels || [];

const EARTH_R_M = 6371000;

/** Great-circle distance in metres. */
export function haversineM(lat1, lng1, lat2, lng2) {
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dp / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return EARTH_R_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Cumulative km at each vertex of a [[lat,lng], ...] polyline. */
function cumulativeKm(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(
      cum[i - 1] +
        haversineM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]) / 1000
    );
  }
  return cum;
}

/**
 * Perpendicular projection of a point onto the polyline.
 * Returns { km, offsetM, segmentIndex } on the POLYLINE axis.
 *
 * Deliberately not nearest-vertex snapping: vertex spacing here runs from 195 m
 * to 11.9 km, so nearest-vertex puts both portals of a short tunnel on the SAME
 * vertex, giving it zero chainage length and making containment undetectable.
 * Measured on 12051: vertex snapping gave a median portal offset of 155 m and a
 * max of 2517 m; perpendicular projection gives median 1 m, max 10 m.
 *
 * Local equirectangular approximation — exact enough at sub-km scale, and avoids
 * a geodesic inverse per segment per portal.
 */
export function projectToPolyline(coords, cum, lat, lng) {
  const mPerDegLat = 111132;
  const mPerDegLng = 111320 * Math.cos((lat * Math.PI) / 180);

  let bestKm = 0;
  let bestD = Infinity;
  let bestI = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    const ax = (coords[i][1] - lng) * mPerDegLng;
    const ay = (coords[i][0] - lat) * mPerDegLat;
    const bx = (coords[i + 1][1] - lng) * mPerDegLng;
    const by = (coords[i + 1][0] - lat) * mPerDegLat;
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    // clamp t so the projection stays on the segment
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lenSq));
    const px = ax + t * dx;
    const py = ay + t * dy;
    const d = Math.hypot(px, py);
    if (d < bestD) {
      bestD = d;
      bestI = i;
      bestKm = cum[i] + t * (cum[i + 1] - cum[i]);
    }
  }

  return { km: bestKm, offsetM: bestD, segmentIndex: bestI };
}

/**
 * Build station anchors: polyline km ↔ timetable km, one pair per station that
 * has BOTH a lat/lng and a timetable `distance`.
 *
 * Requires `includeCoordinates: true` on the live-status call. Without it
 * RailRadar omits station lat/lng and there is nothing to anchor to.
 */
function buildAnchors(coords, cum, route) {
  const anchors = [];
  for (const s of route) {
    const lat = s.lat ?? s.station?.lat;
    const lng = s.lng ?? s.station?.lng;
    if (lat == null || lng == null || s.distance == null) continue;
    const p = projectToPolyline(coords, cum, lat, lng);
    anchors.push({
      code: s.stationCode,
      polylineKm: p.km,
      timetableKm: s.distance,
      offsetM: p.offsetM,
    });
  }

  // Force both axes monotonic. A station that projects out of order (platform vs
  // track centreline, or a doubling-back stretch like CSMT→DR→TNA→PNVL) would
  // otherwise invert a block and produce negative chainage.
  anchors.sort((a, b) => a.timetableKm - b.timetableKm);
  const clean = [];
  for (const a of anchors) {
    const prev = clean[clean.length - 1];
    if (prev && (a.polylineKm <= prev.polylineKm || a.timetableKm <= prev.timetableKm)) {
      continue;
    }
    clean.push(a);
  }
  return clean;
}

/** Map a polyline km onto the timetable axis by interpolating within its block. */
function polylineKmToTimetableKm(polyKm, anchors, polylineTotalKm, timetableTotalKm) {
  if (!anchors.length) {
    // No anchors: fall back to one global scale factor. Callers surface this as
    // axisBasis 'global-scale' so the UI can caveat it — never silently.
    const scale = polylineTotalKm > 0 ? timetableTotalKm / polylineTotalKm : 1;
    return polyKm * scale;
  }

  // Before the first / after the last anchor, extend that block's local scale.
  if (polyKm <= anchors[0].polylineKm) {
    const a = anchors[0];
    const scale = a.polylineKm > 0 ? a.timetableKm / a.polylineKm : 1;
    return polyKm * scale;
  }
  const last = anchors[anchors.length - 1];
  if (polyKm >= last.polylineKm) {
    const polySpan = polylineTotalKm - last.polylineKm;
    const ttSpan = timetableTotalKm - last.timetableKm;
    const scale = polySpan > 0 ? ttSpan / polySpan : 1;
    return last.timetableKm + (polyKm - last.polylineKm) * scale;
  }

  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    if (polyKm >= a.polylineKm && polyKm <= b.polylineKm) {
      const span = b.polylineKm - a.polylineKm;
      const frac = span > 0 ? (polyKm - a.polylineKm) / span : 0;
      return a.timetableKm + frac * (b.timetableKm - a.timetableKm);
    }
  }
  return polyKm;
}

/**
 * Project every tunnel onto a train's timetable axis.
 *
 * @param {Array}  coords            [[lat,lng], ...] route polyline
 * @param {Array}  route             live-status route stations
 * @param {number} timetableTotalKm  train.distance
 * @returns {{ tunnels: Array, axisBasis: string, anchorCount: number, ... }}
 */
export function projectTunnelsOntoRoute(coords, route = [], timetableTotalKm = null) {
  if (!coords || coords.length < 2 || !rawTunnels.length) {
    return {
      tunnels: [],
      axisBasis: 'unavailable',
      anchorCount: 0,
      polylineTotalKm: null,
      timetableTotalKm,
      axisMismatchM: null,
    };
  }

  const cum = cumulativeKm(coords);
  const polylineTotalKm = cum[cum.length - 1];
  const ttTotal = timetableTotalKm || polylineTotalKm;

  const anchors = buildAnchors(coords, cum, route);
  const axisBasis = anchors.length >= 2 ? 'station-anchored' : 'global-scale';

  const tunnels = rawTunnels.map((t) => {
    const a = projectToPolyline(coords, cum, t.portalA.lat, t.portalA.lng);
    const b = projectToPolyline(coords, cum, t.portalB.lat, t.portalB.lng);

    // Entry is always the LOWER chainage: distanceFromOriginKm only ever
    // increases along a run, so direction is handled implicitly. A down-train
    // on the same alignment is still measured from its own origin.
    const loPoly = Math.min(a.km, b.km);
    const hiPoly = Math.max(a.km, b.km);
    const entryKm = polylineKmToTimetableKm(loPoly, anchors, polylineTotalKm, ttTotal);
    const exitKm = polylineKmToTimetableKm(hiPoly, anchors, polylineTotalKm, ttTotal);
    const offsetM = Math.max(a.offsetM, b.offsetM);

    return {
      id: t.id,
      no: t.no,
      name: t.name,
      chordLengthM: t.chordLengthM,
      portalA: t.portalA,
      portalB: t.portalB,
      entryKm: Math.round(entryKm * 1000) / 1000,
      exitKm: Math.round(exitKm * 1000) / 1000,
      chainageLengthM: Math.round((exitKm - entryKm) * 1000 * 10) / 10,
      polylineKm: [Math.round(loPoly * 1000) / 1000, Math.round(hiPoly * 1000) / 1000],
      portalOffsetM: Math.round(offsetM * 10) / 10,
      // A tunnel whose positional uncertainty exceeds its own length cannot
      // support a defensible "you are inside this one" claim. Measured on
      // 12051 this fires on 0 of 69 — the guard exists so a sparser polyline
      // or a different train degrades loudly instead of confidently lying.
      positionalConfidence: offsetM > t.chordLengthM ? 'low' : 'high',
    };
  });

  tunnels.sort((x, y) => x.entryKm - y.entryKm);

  return {
    tunnels,
    axisBasis,
    anchorCount: anchors.length,
    polylineTotalKm: Math.round(polylineTotalKm * 1000) / 1000,
    timetableTotalKm: ttTotal,
    axisMismatchM: Math.round(Math.abs(polylineTotalKm - ttTotal) * 1000),
  };
}

/**
 * Schedule-derived speed for whichever block contains a given chainage.
 *
 * `speedToNextStationKmph` is SCHEDULE-DERIVED, not live (CLAUDE.md VERIFIED
 * #3). There is no live speed field anywhere in this payload, so the basis
 * label travels with the number and the UI must render it.
 */
export function blockSpeedAtKm(route = [], km) {
  let best = null;
  for (const s of route) {
    if (s.distance == null || s.speedToNextStationKmph == null) continue;
    if (s.distance <= km && (!best || s.distance > best.distance)) best = s;
  }
  if (best) {
    return {
      speedKmph: best.speedToNextStationKmph,
      basis: 'schedule',
      basisLabel: `schedule speed for the ${best.stationCode} block — not live GPS`,
      fromStation: best.stationCode,
    };
  }
  return null;
}

/**
 * Where is the train relative to the tunnels?
 *
 * @param {Array}  tunnels  output of projectTunnelsOntoRoute().tunnels
 * @param {number} km       currentLocation.distanceFromOriginKm
 * @param {Object} speed    output of blockSpeedAtKm()
 */
export function findTunnelState(tunnels, km, speed = null) {
  if (!Array.isArray(tunnels) || !tunnels.length || km == null) {
    return { inside: null, ahead: null, passedCount: 0 };
  }

  let inside = null;
  let ahead = null;
  let passedCount = 0;

  for (const t of tunnels) {
    if (km >= t.entryKm && km <= t.exitKm) {
      inside = t;
    } else if (t.exitKm < km) {
      passedCount++;
    } else if (!ahead && t.entryKm > km) {
      ahead = t;
    }
  }

  const speedKmph = speed?.speedKmph ?? null;

  const insideBlock = inside
    ? {
        ...inside,
        metresIn: Math.round((km - inside.entryKm) * 1000),
        metresToExit: Math.round((inside.exitKm - km) * 1000),
        progressPct: inside.chainageLengthM
          ? Math.round(((km - inside.entryKm) * 1000 * 100) / inside.chainageLengthM)
          : null,
        minutesToExit:
          speedKmph > 0
            ? Math.round(((inside.exitKm - km) / speedKmph) * 60 * 10) / 10
            : null,
        minutesTotalTransit:
          speedKmph > 0
            ? Math.round((inside.chainageLengthM / 1000 / speedKmph) * 60 * 10) / 10
            : null,
        speedKmph,
        speedBasis: speed?.basis ?? null,
        speedBasisLabel: speed?.basisLabel ?? null,
      }
    : null;

  const aheadBlock = ahead
    ? {
        ...ahead,
        metresToEntry: Math.round((ahead.entryKm - km) * 1000),
        minutesToEntry:
          speedKmph > 0
            ? Math.round(((ahead.entryKm - km) / speedKmph) * 60 * 10) / 10
            : null,
      }
    : null;

  return {
    inside: insideBlock,
    ahead: aheadBlock,
    passedCount,
    totalCount: tunnels.length,
  };
}

/** Total tunnel length and share of the route — a real, checkable pitch number. */
export function tunnelCoverage(tunnels) {
  const list = tunnels?.length ? tunnels : rawTunnels;
  const totalM = list.reduce((sum, t) => sum + (t.chordLengthM || 0), 0);
  return {
    count: list.length,
    totalKm: Math.round((totalM / 1000) * 10) / 10,
  };
}
