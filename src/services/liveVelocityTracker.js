/**
 * src/services/liveVelocityTracker.js
 *
 * Real-time locomotive velocity tracker and dynamic horizon speed-blender.
 *
 * Problem it solves:
 * RailRadar's `speedToNextStationKmph` is schedule-derived (static across run dates).
 * This service calculates instantaneous ground velocity from consecutive live GPS
 * pings, applies Kalman/EMA smoothing to eliminate GPS jitter, and blends live
 * momentum with downstream timetable speeds over an exponential decay horizon.
 */

const EARTH_RADIUS_M = 6371000.0;
const EMA_ALPHA = 0.35;               // Smoothing factor for velocity EMA
const MIN_PING_INTERVAL_MS = 4000;    // 4 seconds debounce
const MAX_PING_INTERVAL_MS = 600000;  // 10 minutes session window
const MAX_PLAUSIBLE_SPEED_KMH = 160;  // Plausibility clamp for Indian broad-gauge rakes
const STATIONARY_THRESHOLD_M = 15;    // Jitter threshold below which train is stationary
const HORIZON_DECAY_KM = 8.0;         // Exponential decay distance for live momentum

/**
 * Great-circle distance between two (lat, lng) points in metres.
 */
function haversineMetres(lat1, lng1, lat2, lng2) {
  const phi1 = (lat1 * Math.PI) / 180.0;
  const phi2 = (lat2 * Math.PI) / 180.0;
  const dphi = ((lat2 - lat1) * Math.PI) / 180.0;
  const dlambda = ((lng2 - lng1) * Math.PI) / 180.0;

  const a =
    Math.sin(dphi / 2.0) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlambda / 2.0) ** 2;
  return 2.0 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

class LiveVelocityTracker {
  constructor() {
    // Map: trainNumber -> { lastPing: { lat, lng, distKm, timeMs }, history: [], smoothedSpeedKmph, phase }
    this.trains = new Map();
  }

  /**
   * Process a new GPS ping for a train and update its dynamic velocity state.
   *
   * @param {string} trainNumber - 5-digit train number
   * @param {Object} location - { lat, lng, distanceFromOriginKm }
   * @param {string|number|Date} timestamp - timestamp of the ping
   * @param {number|null} timetableSpeedKmph - schedule-derived baseline speed
   * @param {number|null} distanceToNextHaltKm - remaining distance to next halt
   * @returns {Object} Live velocity telemetry
   */
  recordPing(trainNumber, location, timestamp, timetableSpeedKmph = null, distanceToNextHaltKm = null) {
    if (!trainNumber || !location || location.lat == null || location.lng == null) {
      return this.fallbackVelocity(trainNumber, timetableSpeedKmph);
    }

    const lat = Number(location.lat);
    const lng = Number(location.lng);
    const distKm = location.distanceFromOriginKm != null ? Number(location.distanceFromOriginKm) : null;
    const timeMs = timestamp ? new Date(timestamp).getTime() : Date.now();

    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(timeMs)) {
      return this.fallbackVelocity(trainNumber, timetableSpeedKmph);
    }

    const state = this.trains.get(trainNumber) || {
      lastPing: null,
      smoothedSpeedKmph: null,
      sampleCount: 0,
      phase: 'unknown',
    };

    if (!state.lastPing) {
      // First ping: record position as baseline
      state.lastPing = { lat, lng, distKm, timeMs };
      state.sampleCount = 1;
      state.phase = 'acquired';
      this.trains.set(trainNumber, state);
      return this.formatOutput(state, timetableSpeedKmph, distanceToNextHaltKm, null);
    }

    const prev = state.lastPing;
    const deltaMs = timeMs - prev.timeMs;

    // 1. Debounce check: too fast to be a distinct GPS update
    if (deltaMs < MIN_PING_INTERVAL_MS) {
      return this.formatOutput(state, timetableSpeedKmph, distanceToNextHaltKm, null);
    }

    // 2. Session timeout: gap too large, reset tracking baseline
    if (deltaMs > MAX_PING_INTERVAL_MS) {
      state.lastPing = { lat, lng, distKm, timeMs };
      state.sampleCount = 1;
      state.phase = 're-acquired';
      this.trains.set(trainNumber, state);
      return this.formatOutput(state, timetableSpeedKmph, distanceToNextHaltKm, null);
    }

    // 3. Distance delta
    const deltaDistM = haversineMetres(prev.lat, prev.lng, lat, lng);
    const deltaSec = deltaMs / 1000.0;
    const instantKmph = (deltaDistM / deltaSec) * 3.6;

    // 4. Jitter & stationary check
    let verifiedSpeedKmph = instantKmph;
    if (deltaDistM < STATIONARY_THRESHOLD_M && deltaSec >= 15.0) {
      verifiedSpeedKmph = 0.0;
    } else if (instantKmph > MAX_PLAUSIBLE_SPEED_KMH) {
      // Glitch teleport rejection: retain previous speed rather than corrupting filter
      verifiedSpeedKmph = state.smoothedSpeedKmph ?? (timetableSpeedKmph ?? 0.0);
    }

    // 5. Exponential Smoothing (Kalman-style 1D EMA)
    if (state.smoothedSpeedKmph == null) {
      state.smoothedSpeedKmph = verifiedSpeedKmph;
    } else {
      state.smoothedSpeedKmph =
        EMA_ALPHA * verifiedSpeedKmph + (1.0 - EMA_ALPHA) * state.smoothedSpeedKmph;
    }

    // 6. Phase detection
    const prevSpeed = state.smoothedSpeedKmph;
    state.sampleCount += 1;
    if (state.smoothedSpeedKmph < 3.0) {
      state.phase = 'stationary';
    } else if (verifiedSpeedKmph > prevSpeed + 8.0) {
      state.phase = 'accelerating';
    } else if (verifiedSpeedKmph < prevSpeed - 8.0) {
      state.phase = 'decelerating';
    } else {
      state.phase = 'cruising';
    }

    state.lastPing = { lat, lng, distKm, timeMs };
    this.trains.set(trainNumber, state);

    return this.formatOutput(state, timetableSpeedKmph, distanceToNextHaltKm, verifiedSpeedKmph);
  }

  /**
   * Format velocity telemetry and calculate dynamic horizon-blended ETA.
   */
  formatOutput(state, timetableSpeedKmph, distanceToNextHaltKm, instantKmph) {
    const liveSpeed = state.smoothedSpeedKmph != null ? Math.round(state.smoothedSpeedKmph * 10) / 10 : null;
    const schedSpeed = timetableSpeedKmph != null ? Number(timetableSpeedKmph) : null;
    const hasLive = liveSpeed != null && state.sampleCount >= 2;

    // Horizon speed blending:
    // v_eff(d) = w(d) * v_live + (1 - w(d)) * v_sched
    // where w(d) = exp(-d / HORIZON_DECAY_KM)
    let blendedSpeed = schedSpeed;
    let deltaEtaMin = null;

    if (hasLive && schedSpeed != null && schedSpeed > 0 && distanceToNextHaltKm != null && distanceToNextHaltKm > 0) {
      const dist = Number(distanceToNextHaltKm);
      const weight = Math.exp(-dist / HORIZON_DECAY_KM);
      // Effective speed over the block: integration of blended speed
      blendedSpeed = Math.round((weight * liveSpeed + (1.0 - weight) * schedSpeed) * 10) / 10;

      // Delta arrival time in minutes compared to timetable baseline
      const timeLiveHours = dist / Math.max(10.0, blendedSpeed);
      const timeSchedHours = dist / schedSpeed;
      deltaEtaMin = Math.round((timeLiveHours - timeSchedHours) * 60.0 * 10) / 10;
    }

    return {
      isLive: hasLive,
      speedKmph: hasLive ? liveSpeed : schedSpeed,
      liveSpeedKmph: liveSpeed,
      instantKmph: instantKmph != null ? Math.round(instantKmph * 10) / 10 : null,
      timetableSpeedKmph: schedSpeed,
      blendedSpeedNextHaltKmph: blendedSpeed,
      deltaEtaNextHaltMin: deltaEtaMin,
      phase: state.phase,
      samples: state.sampleCount,
      basis: hasLive ? 'live-gps-delta' : 'schedule-derived',
      basisLabel: hasLive
        ? `GPS delta over trailing pings (Kalman EMA, ${state.sampleCount} samples)`
        : 'Schedule-derived block speed (speedToNextStationKmph)',
      horizonDecayKm: HORIZON_DECAY_KM,
    };
  }

  fallbackVelocity(trainNumber, timetableSpeedKmph) {
    const sched = timetableSpeedKmph != null ? Number(timetableSpeedKmph) : null;
    return {
      isLive: false,
      speedKmph: sched,
      liveSpeedKmph: null,
      instantKmph: null,
      timetableSpeedKmph: sched,
      blendedSpeedNextHaltKmph: sched,
      deltaEtaNextHaltMin: null,
      phase: 'unknown',
      samples: 0,
      basis: 'schedule-derived',
      basisLabel: 'Schedule-derived block speed (speedToNextStationKmph)',
      horizonDecayKm: HORIZON_DECAY_KM,
    };
  }

  getVelocity(trainNumber) {
    const state = this.trains.get(trainNumber);
    if (!state) return null;
    return {
      smoothedSpeedKmph: state.smoothedSpeedKmph,
      phase: state.phase,
      samples: state.sampleCount,
      lastPing: state.lastPing,
    };
  }

  reset() {
    this.trains.clear();
  }
}

export const liveVelocityTracker = new LiveVelocityTracker();
export default liveVelocityTracker;
