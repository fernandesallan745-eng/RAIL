/**
 * Hazard confidence scoring — Phase 7, §2 USP 5.
 *
 * Answers "which of these reports is real?" from five independent signals.
 *
 * THE SCORE IS NEVER ONE NUMBER
 * -----------------------------
 * Every component keeps its own sub-score AND its own basis label in the payload.
 * Collapsing them into a single 0.72 would be the VERIFIED #9 failure — a plausible
 * number with no way to tell a genuinely-corroborated report from one that merely
 * had a photo attached. CLAUDE.md §8 requires intermediate numbers be printable;
 * here they are the product, not debug output.
 *
 * THE WEIGHTS ARE UNTUNED GUESSES — SAY SO
 * ----------------------------------------
 * There is no ground-truth set of verified Konkan hazards to fit against, so these
 * weights are our judgement, not a fitted model. Same class of caveat as the
 * untuned curvature.WEATHER_SPEED_FACTOR multipliers (§3) and the priority ladder
 * (VERIFIED #18): the layer is real, the calibration is illustrative. Every payload
 * carries confidenceModelIsHeuristic:true and the UI must render it. Never call
 * this "validated" or quote an accuracy figure for it.
 *
 * WHAT IT MAY NOT DO
 * ------------------
 * It can raise a report to `corroborated` and no further. `confirmed` and
 * `rejected` require a human (CLAUDE.md §2). That ceiling is enforced in
 * classify() and asserted by verify_hazards.py.
 *
 * COST: zero upstream requests. Corroboration reads cached timetables.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { projectToPolyline, haversineM } from './tunnels.js';
import { MACHINE_ASSIGNABLE } from './hazardStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORRIDOR_DIR = path.join(__dirname, '../../.cache/corridor');
const CACHE_DIR = path.join(__dirname, '../../.cache');
const STATIONS_PATH = path.join(__dirname, '../data/konkan-corridor-stations.json');

// ── Tunables. All five are judgement calls; none is fitted to data. ──────────
export const TUNING = {
  // Two reports of the same category within this radius and window corroborate.
  // 2 km because a passenger's phone GPS in a moving train, in a cutting or near a
  // tunnel mouth, is routinely off by hundreds of metres — a tighter radius would
  // reject genuine corroboration as disagreement.
  clusterRadiusM: 2000,
  clusterWindowMin: 90,

  // A report further than this from the rail line is not about a train.
  // 1.5 km is deliberately generous for the same GPS-accuracy reason.
  corridorNearM: 1500,
  corridorFarM: 5000,

  // A train is "present" if its scheduled position is within this of the report.
  presenceWindowMin: 45,
  presenceRadiusKm: 15,

  weights: {
    independentReports: 0.34,   // the strongest signal: independent people agreeing
    corridorPlausibility: 0.24, // filters GPS noise and hoaxes far from any track
    trainPresence: 0.18,        // was a train even scheduled to be there
    reporterCredibility: 0.14,  // this device's track record
    evidence: 0.10,             // a photo
  },

  // Status thresholds on the weighted total.
  candidateAt: 0.35,
  corroboratedAt: 0.62,
};

// ── Corridor geometry, loaded once ──────────────────────────────────────────
let corridorCache = null;

/**
 * Reference alignment: the DENSE route polyline, not station chords.
 *
 * Why this matters, measured rather than assumed. Building the reference from
 * station-to-station chords instead puts real track points a median 470 m, p90
 * 1761 m and max 8503 m FROM the line we call "the track" -- because a chord
 * across a 175 km block is not where the railway runs. At a 1500 m plausibility
 * threshold that would hard-zero 24 genuinely trackside locations out of 1184
 * and penalise 164 of them: a false-negative machine built from our own coarse
 * reference. Against the dense polyline the same stations project to a median of
 * 24 m. Same geometry, two answers -- so we use the dense one.
 *
 * Anchor quality is NOT assumed either. 12 of 87 stations project 3.5-9.3 km off
 * the dense line; those are the Trans-Harbour and Panvel-bypass divergences north
 * of Roha (VERIFIED #23 -- CSMT->Roha is two physically different alignments).
 * Anchors past ANCHOR_MAX_OFFSET_M are dropped rather than trusted.
 */
const ANCHOR_MAX_OFFSET_M = 2000;
const MIN_ANCHORS = 8;

function readDenseRoute() {
  // Reference polyline: 22229's own route. Chosen by measurement -- it is the only
  // dense alignment cached, and it spans CSMT->Madgaon (canonical km -142.2 -> 440.1).
  // Do NOT pick "whichever file has the most vertices": that selects 22226, a
  // genuinely different route whose stations sit 50 km+ from the Konkan line.
  const candidate = path.join(CACHE_DIR, '22229_route.json');
  try {
    const raw = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
    const coords = raw.geojson.geometry.coordinates.map((c) => [c[1], c[0]]);
    if (coords.length < 2) return null;
    const cum = [0];
    for (let i = 1; i < coords.length; i++) {
      cum.push(cum[i - 1] + haversineM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]) / 1000);
    }
    return { coords, cum, totalKm: cum[cum.length - 1] };
  } catch (_) {
    return null;
  }
}

function loadCorridor() {
  if (corridorCache) return corridorCache;

  corridorCache = {
    coords: [], cum: [], totalKm: 0,
    trains: [], stationKm: {},
    available: false,
    basis: 'unavailable',
    anchorsUsed: 0,
    anchorsRejected: 0,
    reason: null,
  };

  try {
    const db = JSON.parse(fs.readFileSync(STATIONS_PATH, 'utf-8'));
    for (const s of db.stations || []) {
      if (s.kmFromRoha != null) corridorCache.stationKm[s.code] = s.kmFromRoha;
    }
  } catch (_) { /* canonical km table optional; only used for the corridorKm label */ }

  const dense = readDenseRoute();
  if (!dense) {
    corridorCache.reason = 'no-dense-route-cached';
    return corridorCache;
  }

  corridorCache.coords = dense.coords;
  corridorCache.cum = dense.cum;
  corridorCache.totalKm = dense.totalKm;

  // Corridor trains, for the scheduled-presence signal. Files without coordinates
  // still carry timetables, so keep every one; only their km is unusable.
  try {
    for (const f of fs.readdirSync(CORRIDOR_DIR).filter((x) => x.endsWith('.json'))) {
      try {
        const t = JSON.parse(fs.readFileSync(path.join(CORRIDOR_DIR, f), 'utf-8'));
        if (t.stations?.length) corridorCache.trains.push(t);
      } catch (_) { /* skip one unreadable file, don't lose the whole layer */ }
    }
  } catch (_) { /* no corridor cache at all -- presence degrades to unavailable */ }

  corridorCache.available = true;
  corridorCache.basis = 'dense-route-polyline';
  return corridorCache;
}

/**
 * Place a lat/lng on the reference alignment.
 *
 * Reports `beyondExtent` when the point projects to a clamped END of the polyline
 * and sits far from it. That is the signature of a location past the cached
 * alignment's coverage (the corridor reaches canonical km 737.1, 22229's polyline
 * only to 440.1) rather than of a hoax. Callers must treat it as UNKNOWN --
 * penalising it would be scoring our own missing data as the user's error, the
 * same mistake VERIFIED #4 records for zero-echo delay dates.
 */
function placeOnCorridor(lat, lng) {
  const c = loadCorridor();
  if (!c.available) return { ok: false, reason: 'geometry-unavailable' };

  const p = projectToPolyline(c.coords, c.cum, lat, lng);
  const lastSeg = c.coords.length - 2;
  const atStart = p.segmentIndex === 0 && p.km < 0.5;
  const atEnd = p.segmentIndex === lastSeg && p.km > c.totalKm - 0.5;
  const beyondExtent = (atStart || atEnd) && p.offsetM > ANCHOR_MAX_OFFSET_M;

  let corridorKm = null;
  if (!beyondExtent) corridorKm = polylineKmToCanonicalKm(p.km, c);

  return { ok: true, offsetM: p.offsetM, polylineKm: p.km, corridorKm, beyondExtent };
}

/** Interpolate polyline km -> canonical km within the bracketing station block. */
function polylineKmToCanonicalKm(polyKm, c) {
  const anchors = c._anchors || (c._anchors = buildCanonicalAnchors(c));
  if (anchors.length < 2) return null;

  if (polyKm <= anchors[0].polyKm) return anchors[0].canonicalKm;
  const last = anchors[anchors.length - 1];
  if (polyKm >= last.polyKm) return last.canonicalKm;

  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    if (polyKm >= a.polyKm && polyKm <= b.polyKm) {
      const span = b.polyKm - a.polyKm;
      const frac = span > 0 ? (polyKm - a.polyKm) / span : 0;
      return a.canonicalKm + frac * (b.canonicalKm - a.canonicalKm);
    }
  }
  return null;
}

/**
 * Station anchors on the canonical axis, with the diverging ones dropped.
 *
 * Every station coordinate pair we have projects onto the dense line; the ones
 * landing >ANCHOR_MAX_OFFSET_M away are on a different alignment and are filtered
 * on measured offset, then forced monotonic on the polyline axis -- a station
 * projecting out of order would otherwise invert a block and produce negative
 * chainage.
 */
function buildCanonicalAnchors(c) {
  const seen = new Map();
  let rejected = 0;

  for (const t of c.trains) {
    for (const s of t.stations || []) {
      if (s.lat == null || s.lng == null || s.km == null) continue;
      if (seen.has(s.code)) continue;
      const canonical = c.stationKm[s.code];
      if (canonical == null) continue;                    // not on the canonical axis
      const p = projectToPolyline(c.coords, c.cum, s.lat, s.lng);
      if (p.offsetM > ANCHOR_MAX_OFFSET_M) { rejected++; continue; }
      seen.set(s.code, { code: s.code, polyKm: p.km, canonicalKm: canonical, offsetM: p.offsetM });
    }
  }

  const sorted = [...seen.values()].sort((a, b) => a.canonicalKm - b.canonicalKm);
  const clean = [];
  for (const a of sorted) {
    const prev = clean[clean.length - 1];
    if (prev && a.polyKm <= prev.polyKm) { rejected++; continue; }
    clean.push(a);
  }

  c.anchorsUsed = clean.length;
  c.anchorsRejected = rejected;
  return clean;
}

// ── Component 1: independent corroboration ──────────────────────────────────
/**
 * §2 USP 5's "independent report count" and "time clustering", together.
 *
 * DISTINCT DEVICES, not distinct reports. One person pressing submit five times is
 * one witness, and counting it as five would make the single easiest way to fake a
 * hazard also the most effective one. This is the invariant verify_hazards.py
 * checks explicitly.
 */
export function scoreIndependentReports(report, peers) {
  const t0 = new Date(report.reportedAt).getTime();
  const devices = new Set();

  for (const p of peers) {
    if (p.id === report.id) continue;
    if (p.category !== report.category) continue;
    if (p.status === 'rejected') continue;                 // a rejected peer corroborates nothing
    const dt = Math.abs(new Date(p.reportedAt).getTime() - t0) / 60000;
    if (dt > TUNING.clusterWindowMin) continue;
    const d = haversineM(report.lat, report.lng, p.lat, p.lng);
    if (d > TUNING.clusterRadiusM) continue;
    devices.add(p.deviceHash);
  }

  // The reporter themselves is one witness.
  devices.add(report.deviceHash);
  const n = devices.size;

  // Saturating, not linear — 1 → 0.0, 2 → 0.4, 3 → 0.667, 4 → 0.75, 5 → 0.8,
  // approaching but never reaching 1. verify_hazards.py H5 pins these exact
  // values, because this comment previously claimed 0.6/0.8/0.9/1.0 and every
  // one of them was wrong: a docstring that drifts from its formula is worse
  // than none, since it is the thing a reader checks the weights against.
  //
  // The `-0.1` at n === 2 damps the two-witness case ON PURPOSE, and the old
  // comment had its rationale backwards. Two reports are the EASIEST corroboration
  // to fake — one person with two phones, or two people travelling together who
  // saw the same thing wrong — so a single corroborating device buys less than
  // the 1-1/n curve alone would give it. The third independent device is the one
  // that is hard to manufacture, and it is where the curve jumps most (+0.267).
  const score = n <= 1 ? 0 : Math.min(1, 1 - 1 / n - (n === 2 ? 0.1 : 0));

  return {
    score: Number(score.toFixed(3)),
    independentDevices: n,
    corroboratingReports: devices.size - 1,
    basis: 'distinct-device-hashes',
    note: n <= 1
      ? 'Single reporter — no independent corroboration yet.'
      : `${n} independent devices reported ${report.category} within `
        + `${TUNING.clusterRadiusM} m and ${TUNING.clusterWindowMin} min.`,
  };
}

// ── Component 2: corridor plausibility ──────────────────────────────────────
/**
 * How far the report is from the rail line, by PERPENDICULAR projection.
 *
 * Reuses projectToPolyline (tunnels.js:83) rather than nearest-vertex snapping.
 * VERIFIED #11 measured that difference: vertex snapping gave a median 155 m / max
 * 2517 m error where projection gives median 1 m / max 10 m. At a 1500 m threshold
 * a 2517 m quantisation error is not a rounding detail — it decides the answer.
 * VERIFIED #24 is the same bug found a third time; this is the fourth surface, so
 * it projects.
 */
export function scoreCorridorPlausibility(report) {
  const c = loadCorridor();
  if (!c.available) {
    return {
      score: null, offsetM: null, corridorKm: null,
      basis: 'unavailable',
      note: 'No corridor polyline cached, so distance-from-track cannot be checked. '
          + 'Not counted as evidence either way.',
    };
  }

  const placed = placeOnCorridor(report.lat, report.lng);
  if (!placed.ok) {
    return {
      score: null, offsetM: null, corridorKm: null,
      basis: 'unavailable', reason: placed.reason,
      note: 'Report could not be placed against the reference alignment.',
    };
  }

  // Past the cached alignment's extents: we do not know how far this is from the
  // track, because we have no track there. Excluded (null), never scored 0.
  if (placed.beyondExtent) {
    return {
      score: null,
      offsetM: Math.round(placed.offsetM),
      corridorKm: null,
      basis: 'beyond-cached-extent',
      note: `This point is beyond the cached reference alignment (which spans canonical `
          + `km ${c.stationKm ? '-142 to 440' : '?'}), so its distance from track is unknown. `
          + 'Excluded from scoring rather than counted against the report.',
    };
  }

  const { offsetM } = placed;

  let score;
  if (offsetM <= TUNING.corridorNearM) score = 1;
  else if (offsetM >= TUNING.corridorFarM) score = 0;
  else score = 1 - (offsetM - TUNING.corridorNearM) / (TUNING.corridorFarM - TUNING.corridorNearM);

  return {
    score: Number(score.toFixed(3)),
    offsetM: Math.round(offsetM),
    corridorKm: placed.corridorKm == null ? null : Number(placed.corridorKm.toFixed(1)),
    basis: 'perpendicular-projection',
    note: offsetM <= TUNING.corridorNearM
      ? `${Math.round(offsetM)} m from the reference alignment — on the corridor.`
      : offsetM >= TUNING.corridorFarM
        ? `${Math.round(offsetM)} m from any cached track — implausible for a rail hazard.`
        : `${Math.round(offsetM)} m from the reference alignment — near, but not on, the corridor.`,
  };
}

// ── Component 3: train presence (SCHEDULED, not live) ───────────────────────
/**
 * Was a train actually due to be there when this was reported?
 *
 * §2 USP 5 says "location match against live train position". We do not have that:
 * VERIFIED #3 established this source carries no live speed, and the live fleet is
 * one train (FLEET_TRAINS=12051). So this matches against cached TIMETABLES and
 * labels itself `scheduled` everywhere it appears. Free, honest, and useful — a
 * report of an engine failure at a km where no train was due is worth flagging.
 * Calling it live would not be honest (§3, §8).
 *
 * Day-normalised minutes per VERIFIED #16 — comparing raw ISO timestamps across
 * service dates finds nothing.
 */
export function scoreTrainPresence(report) {
  const c = loadCorridor();
  if (!c.available || !c.trains.length) {
    return {
      score: null, basis: 'unavailable', trainsNearby: [],
      note: 'No corridor timetables cached, so scheduled-train presence cannot be checked.',
    };
  }

  const placed = placeOnCorridor(report.lat, report.lng);
  if (!placed.ok || placed.beyondExtent || placed.corridorKm == null) {
    return {
      score: null, basis: 'unavailable', trainsNearby: [],
      note: 'Report is not placeable on the canonical corridor axis, so scheduled '
          + 'presence cannot be checked. Excluded, not scored as absent.',
    };
  }

  const minuteOfDay = istMinuteOfDay(report.reportedAt);
  const nearby = [];

  for (const t of c.trains) {
    // Best match per train, not the first one in sequence order: a block like
    // RN->BOKE has several stations inside the 15 km radius that also fall inside the
    // 45 min window, and taking whichever is filed first reported a station 6.6 km
    // away when the report was on top of the nearer one. Nearest wins.
    let best = null;

    for (const s of t.stations || []) {
      if (s.arrMin == null && s.depMin == null) continue;

      // Join on station CODE against the canonical axis -- never on the train's own
      // `s.km`. That field is distance from ITS origin: it equals canonical km only
      // for the CSMT-origin trains (offset +142.2). Measured across the cache, the
      // own-minus-canonical offset is constant for 12051/22229, ±0.7 km for 10103,
      // and swings over 1,600 km for 12617/16346 -- comparing it to a canonical km
      // would silently never match a long-distance train. Code is the join key
      // (VERIFIED #15), and the km comes only from the canonical table (VERIFIED #22).
      const canon = c.stationKm[s.code];
      if (canon == null) continue;
      const kmDelta = Math.abs(canon - placed.corridorKm);
      if (kmDelta > TUNING.presenceRadiusKm) continue;

      // Time-of-day only: the cached schedules are route templates, not dated runs,
      // so we can say "a train is scheduled through here at this time of day" and
      // nothing stronger. Normalising with a modulo also collapses a multi-day run's
      // >1440 min offsets (VERIFIED #16), at the cost of losing which day.
      const at = s.arrMin != null ? s.arrMin : s.depMin;
      const schedMin = ((at % 1440) + 1440) % 1440;
      let dt = Math.abs(schedMin - minuteOfDay);
      if (dt > 720) dt = 1440 - dt;                       // wrap around midnight
      if (dt > TUNING.presenceWindowMin) continue;

      if (!best || kmDelta < best.kmDelta) {
        best = {
          train: t.number, name: t.name, station: s.code,
          corridorKm: canon, kmDelta: Number(kmDelta.toFixed(1)),
          deltaMin: Math.round(dt),
        };
      }
    }

    if (best) nearby.push(best);
  }

  const score = nearby.length ? Math.min(1, 0.7 + 0.15 * (nearby.length - 1)) : 0;

  return {
    score: Number(score.toFixed(3)),
    trainsNearby: nearby.slice(0, 4),
    basis: 'scheduled',                 // NEVER 'live' -- see the header
    reportedIstMinute: minuteOfDay,
    note: nearby.length
      ? `${nearby.length} train(s) scheduled through within ${TUNING.presenceRadiusKm} km / `
        + `${TUNING.presenceWindowMin} min of this point. Scheduled timetables, not live positions; `
        + `matched on time of day, not on a specific service date.`
      : 'No cached train is scheduled through this point at this time of day. '
        + 'Only the corridor roster is cached, so this is weak evidence, not proof of absence.',
  };
}

/**
 * Minutes since midnight in IST, whatever zone the host runs in.
 *
 * The cached `arrMin` values are IST minutes since the service day's start (VERIFIED
 * #16), so the comparison must be made in IST. `getHours()` happens to be correct on
 * a laptop set to Asia/Calcutta and silently wrong on any UTC host -- and because
 * presence is gated at 45 min, a 5.5 h skew does not degrade the signal, it zeroes it
 * everywhere while still looking like a legitimate "no train was due" answer. That is
 * the VERIFIED #9 failure shape, so the zone is pinned rather than inherited.
 */
function istMinuteOfDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 0;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const hh = Number(parts.find((p) => p.type === 'hour').value) % 24;
  const mm = Number(parts.find((p) => p.type === 'minute').value);
  return hh * 60 + mm;
}

// ── Component 4: reporter credibility ───────────────────────────────────────
/**
 * This device's record, with a NEUTRAL PRIOR.
 *
 * A first-time reporter scores 0.5, not 0. Most genuine reports come from someone
 * reporting for the first time — that is the nature of a passenger witnessing a
 * landslide — so penalising newness would suppress exactly the reports the feature
 * exists to capture. Only a demonstrated history moves the number.
 */
export function scoreReporterCredibility(report, peers) {
  const own = peers.filter((p) => p.deviceHash === report.deviceHash && p.id !== report.id);
  const confirmed = own.filter((p) => p.status === 'confirmed').length;
  const rejected = own.filter((p) => p.status === 'rejected').length;
  const decided = confirmed + rejected;

  if (!decided) {
    return {
      score: 0.5, priorReports: own.length, confirmed, rejected,
      basis: 'neutral-prior',
      note: own.length
        ? `${own.length} earlier report(s) from this device, none yet decided — neutral.`
        : 'First report from this device — neutral prior, not penalised.',
    };
  }

  // Laplace-smoothed, so one rejection does not zero a reporter permanently.
  const score = (confirmed + 1) / (decided + 2);

  return {
    score: Number(score.toFixed(3)), priorReports: own.length, confirmed, rejected,
    basis: 'approval-history',
    note: `${confirmed} confirmed / ${rejected} rejected across ${decided} decided report(s) from this device.`,
  };
}

// ── Component 5: evidence ───────────────────────────────────────────────────
/**
 * A photo, and a description substantial enough to act on.
 *
 * Weakest of the five by design: a photo proves something was seen, not where or
 * when. It cannot carry a report on its own — at weight 0.10 a photo-only report
 * tops out well below the `candidate` threshold.
 */
export function scoreEvidence(report) {
  const hasPhoto = Boolean(report.photoPath);
  const desc = (report.description || '').trim();
  const hasDesc = desc.length >= 15;

  const score = (hasPhoto ? 0.7 : 0) + (hasDesc ? 0.3 : 0);

  return {
    score: Number(score.toFixed(3)),
    hasPhoto, descriptionChars: desc.length,
    basis: 'attachments',
    note: hasPhoto
      ? (hasDesc ? 'Photo and a written description attached.' : 'Photo attached, description is brief.')
      : (hasDesc ? 'Written description only — no photo.' : 'No photo and only a brief description.'),
  };
}

// ── Combine ─────────────────────────────────────────────────────────────────
/**
 * Score one report against its peers.
 *
 * Unavailable components (null score) are EXCLUDED from both numerator and
 * denominator, and named in `componentsUnavailable`. Scoring a missing signal as
 * zero would punish a report for our own missing cache file — the same mistake
 * VERIFIED #4 records for zero-echo delay dates, which must be skipped rather than
 * averaged in as zeros.
 */
export function scoreReport(report, peers = []) {
  const components = {
    independentReports: scoreIndependentReports(report, peers),
    corridorPlausibility: scoreCorridorPlausibility(report),
    trainPresence: scoreTrainPresence(report),
    reporterCredibility: scoreReporterCredibility(report, peers),
    evidence: scoreEvidence(report),
  };

  let weighted = 0;
  let weightUsed = 0;
  const unavailable = [];

  for (const [key, c] of Object.entries(components)) {
    const w = TUNING.weights[key];
    if (c.score == null) { unavailable.push(key); continue; }
    weighted += c.score * w;
    weightUsed += w;
  }

  // Renormalise over the weight actually available, so a missing signal lowers
  // certainty without inventing a penalty.
  const confidence = weightUsed > 0 ? weighted / weightUsed : 0;

  return {
    confidence: Number(confidence.toFixed(3)),
    machineStatus: classify(confidence),
    components,
    componentsUnavailable: unavailable,
    weightUsed: Number(weightUsed.toFixed(3)),
    weights: TUNING.weights,
    thresholds: { candidateAt: TUNING.candidateAt, corroboratedAt: TUNING.corroboratedAt },

    // Honesty flags — §5e style. The UI renders these; do not remove them.
    confidenceModelIsHeuristic: true,
    trainPresenceBasis: 'scheduled',
    decisionSupportOnly: true,
    note: 'Confidence is a weighted heuristic over five signals, not a trained or '
        + 'validated model — there is no ground-truth hazard set to calibrate against. '
        + 'It can raise a report to "corroborated" at most; only a human controller '
        + 'can confirm or reject one.',
  };
}

/**
 * Map a confidence to a status. THE CEILING IS `corroborated`.
 *
 * This function is the enforcement point for CLAUDE.md §2's human-confirmation rule
 * and cannot return 'confirmed' or 'rejected' by construction. The assertion below
 * is not decoration: if someone later adds a threshold branch that returns
 * 'confirmed', the process fails loudly at that call rather than silently
 * auto-escalating a hazard, which is the one failure mode this whole layer exists
 * to prevent.
 */
export function classify(confidence) {
  const status = confidence >= TUNING.corroboratedAt ? 'corroborated'
               : confidence >= TUNING.candidateAt ? 'candidate'
               : 'logged';
  if (!MACHINE_ASSIGNABLE.includes(status)) {
    throw new Error(`classify() produced non-machine-assignable status "${status}" — `
      + `only a human may set confirmed/rejected (CLAUDE.md §2).`);
  }
  return status;
}

/** Score a whole list against itself — what the API and the map layer use. */
export function scoreAll(reports) {
  return reports.map((r) => ({ ...r, scoring: scoreReport(r, reports) }));
}

export function corridorAvailable() {
  const c = loadCorridor();
  return { available: c.available, referenceVertices: c.coords.length, corridorTrains: c.trains.length };
}

/** Test seam. */
export function _resetCorridorCache() {
  corridorCache = null;
}
