"""
eta_model.py — Combined curvature + delay-aware ETA model for Indian Railways
coaching trains.  Reference train: 22229 (CSMT–Madgaon Vande Bharat).

Layers, per halt-to-halt segment:
  1. baseline_speed      = schedule-derived speedToNextStationKmph (the timetable
                           already paces each block; this encodes real-world slack)
  2. curvature_cap       = 4.58 * sqrt(min curve radius in the segment)   [RDSO BG]
  3. weather_cap         = min(max_speed, curvature_cap) * weather_factor
  4. effective_speed     = min(baseline, curvature_cap, weather_cap)      [task formula]
  5. historical_delay    = mean *incremental* delay per segment, differenced from the
                           cumulative delayArrival across past dated runs
  6. dwell               = scheduledDeparture - scheduledArrival at the arriving halt

  segment_eta = distance/effective_speed  +  historical_delay  +  dwell
  total_eta   = Σ segment_eta

Everything is CACHE-FIRST: it only ever reads .cache/*.json (never calls the API
unless a file is missing AND the network is reachable).
"""
import os, json, glob, math
from datetime import datetime, timedelta

import curvature  # circumradius / permissible speed / haversine helpers

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache")
DEFAULT_TRAIN = "22229"
MAX_SPEED_KMH = 80          # verified actual operating max for 22229 (not rated 130)
CURVE_K = curvature.CURVE_SPEED_CONSTANT  # 4.58


# ────────────────────────────────────────────────────────────────────────────
#  Cache-first loaders
# ────────────────────────────────────────────────────────────────────────────
def _load(path):
    with open(path) as f:
        return json.load(f)


def load_route_coords(train=DEFAULT_TRAIN):
    """[lng,lat] geometry from the /route endpoint cache (extra 'geojson' wrapper)."""
    path = os.path.join(CACHE, f"{train}_route.json")
    if not os.path.exists(path):
        raise FileNotFoundError(f"Missing route cache: {path}")
    return _load(path)["geojson"]["geometry"]["coordinates"]


def list_dated_runs(train=DEFAULT_TRAIN):
    """All cached historical dated runs, sorted by date."""
    out = {}
    for p in sorted(glob.glob(os.path.join(CACHE, f"{train}_live_20*.json"))):
        d = os.path.basename(p).replace(f"{train}_live_", "").replace(".json", "")
        out[d] = _load(p)
    return out


def load_schedule(train=DEFAULT_TRAIN, date=None):
    """
    Return (train_info, route_stations, source_label) for a given train.

    Priority:
    1. Dated live cache  ({train}_live_{date}.json)
    2. Any dated live cache (schedule is identical across dates)
    3. Undated live snapshot ({train}_live.json)
    4. Full corridor dataset (konkan_full_corridor_trains.json) — halt-only,
       no speedToNextStationKmph from the API, so baseline speed is derived
       from consecutive halt times and distances instead.
    """
    candidates = []
    if date:
        candidates.append(os.path.join(CACHE, f"{train}_live_{date}.json"))
    candidates += sorted(glob.glob(os.path.join(CACHE, f"{train}_live_20*.json")))
    candidates.append(os.path.join(CACHE, f"{train}_live.json"))
    for path in candidates:
        if os.path.exists(path):
            j = _load(path)
            return j.get("train", {}), j.get("route", []), os.path.basename(path)
    # Fall back to the full 206-train corridor dataset (no API calls required).
    return _load_schedule_from_full_dataset(train)


# ── full-corridor-dataset schedule adapter ────────────────────────────────────

FULL_DATASET_PATH = os.path.join(CACHE, "konkan_full_corridor_trains.json")
_full_dataset_cache = None

def _full_dataset():
    global _full_dataset_cache
    if _full_dataset_cache is not None:
        return _full_dataset_cache
    if not os.path.exists(FULL_DATASET_PATH):
        _full_dataset_cache = {}
        return _full_dataset_cache
    with open(FULL_DATASET_PATH) as f:
        raw = json.load(f)
    _full_dataset_cache = {str(r["train_number"]): r for r in raw.get("trains", [])}
    return _full_dataset_cache


_REF_DATE = datetime(2026, 1, 1)


def _hhmm_day_to_iso(hhmm, day):
    """Convert HH:MM + 1-based day offset to an ISO datetime string."""
    if not hhmm:
        return None
    try:
        h, m = map(int, str(hhmm).strip().split(":"))
        dt = _REF_DATE + timedelta(days=int(day) - 1, hours=h, minutes=m)
        return dt.isoformat()
    except (ValueError, AttributeError):
        return None


def _load_schedule_from_full_dataset(train):
    """
    Adapt a full-dataset record to the (train_info, stations, source) tuple
    that compute_eta expects.

    The full dataset carries halt stations only (no pass-through rows) and
    uses HH:MM strings rather than ISO timestamps.  speedToNextStationKmph
    is derived from consecutive halt distances and scheduled running times,
    the same quantity the RailRadar cache encodes directly.
    """
    rec = _full_dataset().get(str(train))
    if rec is None:
        raise FileNotFoundError(
            f"No cached live/schedule file found for train {train}, "
            f"and it is not in the full corridor dataset "
            f"({FULL_DATASET_PATH})."
        )

    raw_stations = []
    for i, s in enumerate(rec.get("corridor_stations", [])):
        sched = s.get("scheduled") or {}
        arr_day = int(sched.get("arrDay", sched.get("day", 1)))
        dep_day = int(sched.get("depDay", sched.get("day", 1)))
        arr_iso = _hhmm_day_to_iso(sched.get("arr"), arr_day)
        dep_iso = _hhmm_day_to_iso(sched.get("dep"), dep_day)
        km = sched.get("trainKm")
        if km is None:
            continue
        raw_stations.append({
            "stationCode":        s["code"],
            "stationName":        s.get("name", ""),
            "distance":           float(km),
            "sequence":           i,
            "isHalt":             sched.get("stopType", "halt") != "pass",
            "scheduledArrival":   arr_iso,
            "scheduledDeparture": dep_iso,
            # lat/lng absent in this source; snap_halts_to_vertices falls back
            # to proportional placement when coordinates are missing.
        })

    # trainKm is absolute km from the train's own origin.  Sort ascending so
    # stations are in travel order (low→high trainKm = geographical south→north
    # on this corridor regardless of which end the train started from), then
    # normalise to distance-from-first-corridor-station so the first stop is 0.
    raw_stations.sort(key=lambda s: s["distance"])
    origin_km = raw_stations[0]["distance"] if raw_stations else 0.0
    stations = []
    for s in raw_stations:
        s["distance"] = round(s["distance"] - origin_km, 3)
        stations.append(s)

    # Derive speedToNextStationKmph for each block from the halt pair that
    # brackets it — the same figure the live cache exposes as a direct field.
    halts = [s for s in stations if s.get("isHalt")]
    for k in range(len(halts) - 1):
        a, b = halts[k], halts[k + 1]
        a_dep = _dt(a.get("scheduledDeparture"))
        b_arr = _dt(b.get("scheduledArrival"))
        dist = b["distance"] - a["distance"]
        if a_dep and b_arr and dist > 0:
            run_min = (b_arr - a_dep).total_seconds() / 60.0
            speed = dist / run_min * 60.0 if run_min > 0 else None
        else:
            speed = None
        for s in stations:
            if a["distance"] <= s["distance"] < b["distance"]:
                s["speedToNextStationKmph"] = speed

    train_info = {
        "name":     rec.get("train_name"),
        "number":   rec["train_number"],
        "duration": None,
    }
    if halts and halts[0].get("scheduledDeparture") and halts[-1].get("scheduledArrival"):
        dep0 = _dt(halts[0]["scheduledDeparture"])
        arr_n = _dt(halts[-1]["scheduledArrival"])
        if dep0 and arr_n:
            train_info["duration"] = round((arr_n - dep0).total_seconds() / 60.0, 1)

    return train_info, stations, f"full-dataset:{train}"


# ────────────────────────────────────────────────────────────────────────────
#  Geometry → per-segment curvature
# ────────────────────────────────────────────────────────────────────────────
def geometry_cumulative_km(coords):
    """Cumulative great-circle distance (km) at each [lng,lat] vertex."""
    cum = [0.0]
    for (lng0, lat0), (lng1, lat1) in zip(coords[:-1], coords[1:]):
        cum.append(cum[-1] + curvature.haversine_m(lat0, lng0, lat1, lng1) / 1000.0)
    return cum


def snap_halts_to_vertices(coords, halts):
    """
    Map each halt to its nearest geometry vertex using the halt's own lat/lng.

    This replaces the earlier approach of rescaling the whole geometry onto the
    schedule's km axis with ONE global factor.  That global factor left each block
    carrying a share of the 581.4 km-geometry vs 588 km-schedule mismatch, which
    showed up as ±0.5 min of per-block noise — enough to make per-vertex running
    time land *below* the baseline-only time, i.e. curvature apparently speeding
    the train up.  Anchoring on real halt coordinates removes that coupling: each
    block is then scaled independently against its own timetable km-posts.

    Station coordinates sit up to ~800 m off the track centreline (platform vs
    polyline), so a snap can be 1-2 vertices out.  Across blocks of 9-175 km that
    is immaterial, but it is why indices are forced monotonic rather than trusted.

    Returns a list of vertex indices, one per halt, strictly increasing.
    """
    idx = []
    lo = 0
    for h in halts:
        hlat, hlng = h.get("lat"), h.get("lng")
        if hlat is None or hlng is None:
            # No coordinates: fall back to proportional placement along the polyline.
            idx.append(lo)
            lo += 1
            continue
        best_i, best_d = lo, math.inf
        for i in range(lo, len(coords)):
            lng, lat = coords[i]
            d = curvature.haversine_m(hlat, hlng, lat, lng)
            if d < best_d:
                best_d, best_i = d, i
        # force strictly increasing so blocks can never overlap or invert
        best_i = max(best_i, lo)
        idx.append(best_i)
        lo = min(best_i + 1, len(coords) - 1)
    idx[-1] = len(coords) - 1        # last halt anchors to the end of the polyline
    return idx


def sharpest_radius_in_block(coords, i0, i1):
    """
    Min circumradius (m) among vertex-triples strictly inside vertex range [i0, i1].
    Returns (min_radius_m, lat_of_sharpest) or (inf, None) if straight/too short.
    """
    ref_lng, ref_lat = coords[0]
    best_r, best_lat = math.inf, None
    for i in range(max(i0, 1), min(i1 + 1, len(coords) - 1)):
        p1 = curvature._to_local_xy(coords[i - 1][1], coords[i - 1][0], ref_lat, ref_lng)
        p2 = curvature._to_local_xy(coords[i][1], coords[i][0], ref_lat, ref_lng)
        p3 = curvature._to_local_xy(coords[i + 1][1], coords[i + 1][0], ref_lat, ref_lng)
        r = curvature.circumradius(p1, p2, p3)
        if r < best_r:
            best_r, best_lat = r, coords[i][1]
    return best_r, best_lat


def block_vertex_running_min(coords, cum_km, i0, i1, block_km, baseline, max_speed, wfactor):
    """
    Physically correct running time for one halt-to-halt block: integrate
    distance/speed sub-segment by sub-segment, capping EACH sub-segment (median ~195 m
    on this polyline) by its own curve radius rather than letting the block's worst
    curve govern all of it.

    Sub-segment lengths are renormalised so they sum to `block_km` (the timetable's
    distance for this block).  That makes the invariant exact: with no curve binding,
    Σ(d_i/baseline) == block_km/baseline == the baseline-only time, so any difference
    the model reports IS curvature and nothing else.

    Returns (running_min, n_sub_segments, n_capped_by_curve).
    """
    raw = []
    for i in range(i0 + 1, i1 + 1):
        seg_km = cum_km[i] - cum_km[i - 1]
        # radius at the *middle* vertex of the triple ending at i; ends read as straight
        if 1 <= i <= len(coords) - 2:
            ref_lng, ref_lat = coords[0]
            p1 = curvature._to_local_xy(coords[i - 1][1], coords[i - 1][0], ref_lat, ref_lng)
            p2 = curvature._to_local_xy(coords[i][1], coords[i][0], ref_lat, ref_lng)
            p3 = curvature._to_local_xy(coords[i + 1][1], coords[i + 1][0], ref_lat, ref_lng)
            r = curvature.circumradius(p1, p2, p3)
        else:
            r = math.inf
        raw.append((seg_km, r))

    geom_km = sum(s for s, _ in raw)
    if geom_km <= 0:
        return block_km / baseline * 60.0 if baseline else 0.0, 0, 0
    norm = block_km / geom_km          # per-block scale, not one global factor

    total_min = 0.0
    n_capped = 0
    for seg_km, r in raw:
        curve_cap = max_speed if math.isinf(r) else min(max_speed, CURVE_K * math.sqrt(r))
        eff = min(baseline, curve_cap * wfactor)
        if curve_cap * wfactor < baseline:
            n_capped += 1
        if eff > 0:
            total_min += (seg_km * norm) / eff * 60.0
    return total_min, len(raw), n_capped


def sharpest_radius_in_range(coords, cum_km, d0, d1):
    """
    Min circumradius (m) among vertex-triples whose *middle* vertex falls in
    [d0, d1] km.  Returns (min_radius_m, lat_of_sharpest) or (inf, None) if the
    range is straight / too short.
    """
    ref_lng, ref_lat = coords[0]
    best_r, best_lat = math.inf, None
    for i in range(1, len(coords) - 1):
        if not (d0 <= cum_km[i] <= d1):
            continue
        p1 = curvature._to_local_xy(coords[i - 1][1], coords[i - 1][0], ref_lat, ref_lng)
        p2 = curvature._to_local_xy(coords[i][1], coords[i][0], ref_lat, ref_lng)
        p3 = curvature._to_local_xy(coords[i + 1][1], coords[i + 1][0], ref_lat, ref_lng)
        r = curvature.circumradius(p1, p2, p3)
        if r < best_r:
            best_r, best_lat = r, coords[i][1]
    return best_r, best_lat


def vertex_running_min(coords, cum_km, d0, d1, baseline, max_speed, wfactor):
    """
    Physically correct running time for a halt-to-halt block: integrate
    distance/speed vertex-by-vertex, capping EACH short vertex segment by its own
    curve radius instead of applying the block's worst curve to the whole block.

    Returns (running_min, n_vertex_segments, n_capped_by_curve).
    """
    ref_lng, ref_lat = coords[0]
    total_min = 0.0
    n_seg = n_capped = 0
    for i in range(1, len(coords) - 1):
        if not (d0 <= cum_km[i] <= d1):
            continue
        p1 = curvature._to_local_xy(coords[i - 1][1], coords[i - 1][0], ref_lat, ref_lng)
        p2 = curvature._to_local_xy(coords[i][1], coords[i][0], ref_lat, ref_lng)
        p3 = curvature._to_local_xy(coords[i + 1][1], coords[i + 1][0], ref_lat, ref_lng)
        r = curvature.circumradius(p1, p2, p3)
        seg_km = cum_km[i] - cum_km[i - 1]
        curve_cap = max_speed if math.isinf(r) else min(max_speed, CURVE_K * math.sqrt(r))
        eff = min(baseline, curve_cap * wfactor)
        if curve_cap * wfactor < baseline:
            n_capped += 1
        if eff > 0 and seg_km > 0:
            total_min += seg_km / eff * 60.0
        n_seg += 1
    return total_min, n_seg, n_capped


# ────────────────────────────────────────────────────────────────────────────
#  Historical delay (data-derived buffer)  — mean delayArrival across dates
# ────────────────────────────────────────────────────────────────────────────
def historical_delay_by_seq(train=DEFAULT_TRAIN):
    """
    Mean CUMULATIVE delayArrival (minutes) per station-sequence across cached runs.

    WARNING: delayArrival is cumulative -- it equals actualArrival - scheduledArrival,
    so it already contains every minute lost earlier in the journey.  These values
    must NEVER be summed across halts.  Use historical_delay_increment_by_seq() for
    anything additive.  Kept because the cumulative view is the right one for
    "how late is this train at station X" reporting.  Returns {seq: (mean, n)}.
    """
    runs = list_dated_runs(train)
    acc = {}
    for j in runs.values():
        for s in j.get("route", []):
            da = s.get("delayArrival")
            if da is not None:
                acc.setdefault(s["sequence"], []).append(da)
    return {seq: (sum(v) / len(v), len(v)) for seq, v in acc.items()}


def historical_delay_increment_by_seq(train=DEFAULT_TRAIN):
    """
    Mean INCREMENTAL delay (minutes) added on the approach to each halt.

    delayArrival is cumulative, so summing it across halts double-counts badly: on
    2026-08-21 the eight cumulative values sum to +149 min for a run that actually
    finished 3 min EARLY.  Differencing along the halt chain, per date, fixes it:

        increment(b) = cum_delay(b) - cum_delay(a)     for consecutive halts a, b

    The origin's cumulative delay is its own delayDeparture (0-6 min in practice).
    Summed over a journey these increments telescope back to the end-to-end delay,
    which is the only delay figure that may legitimately be added to a
    schedule-derived running time.

    Dates with no delay signal at all are skipped entirely rather than counted as
    zeros -- a completed-but-untracked run reports 0, and averaging those in would
    dilute the real delays toward zero.  Where a single halt is missing on an
    otherwise-good date, its increment merges into the next observed halt; that
    slightly over-attributes to that halt but keeps the telescoping total exact,
    which is what the ETA depends on.

    Returns {seq: (mean_increment_min, n_samples)}.
    """
    runs = list_dated_runs(train)
    acc = {}
    for j in runs.values():
        halts = [s for s in j.get("route", []) if s.get("isHalt")]
        if len(halts) < 2 or halts[-1].get("delayArrival") is None:
            continue                      # no real signal on this date
        prev = halts[0].get("delayDeparture") or 0.0
        for s in halts[1:]:
            da = s.get("delayArrival")
            if da is None:
                continue                  # gap: fold into the next observed halt
            acc.setdefault(s["sequence"], []).append(da - prev)
            prev = da
    return {seq: (sum(v) / len(v), len(v)) for seq, v in acc.items()}


# ────────────────────────────────────────────────────────────────────────────
#  Core model
# ────────────────────────────────────────────────────────────────────────────
def end_to_end_delay_samples(train=DEFAULT_TRAIN):
    """
    Per-date end-to-end delay (min) = cumulative delayArrival at the final halt.

    This is the ground truth the per-segment increments should reproduce.  They can
    drift from it when halts have unequal date coverage (a mean of sums is not a sum
    of means), so compute_eta reports both and the gap between them.
    Returns (samples_by_date, mean_or_None).
    """
    out = {}
    for d, j in list_dated_runs(train).items():
        halts = [s for s in j.get("route", []) if s.get("isHalt")]
        if halts and halts[-1].get("delayArrival") is not None:
            out[d] = halts[-1]["delayArrival"]
    return out, (sum(out.values()) / len(out) if out else None)


def geometry_resolution(coords, blind_threshold_km=1.0):
    """
    How much of the route the curvature layer can actually SEE.

    A 3-point circumradius cannot resolve a curve shorter than its own chord, so
    wherever consecutive vertices are far apart the alignment is effectively a
    straight line to us — curvature there is undetectable, not absent.  Reporting
    this alongside any curvature number keeps the claim honest.
    """
    cum = geometry_cumulative_km(coords)
    sp = [cum[i] - cum[i - 1] for i in range(1, len(cum))]
    if not sp:
        return {}
    srt = sorted(sp)
    blind_km = sum(x for x in sp if x > blind_threshold_km)
    return {
        "vertices": len(coords),
        "total_km": round(cum[-1], 1),
        "spacing_m": {
            "min": round(srt[0] * 1000),
            "median": round(srt[len(srt) // 2] * 1000),
            "p75": round(srt[3 * len(srt) // 4] * 1000),
            "max": round(srt[-1] * 1000),
        },
        "blind_threshold_km": blind_threshold_km,
        "spans_over_threshold": sum(1 for x in sp if x > blind_threshold_km),
        "curvature_blind_km": round(blind_km, 1),
        "curvature_blind_pct": round(blind_km / cum[-1] * 100, 1),
        "resolvable_pct": round(100 - blind_km / cum[-1] * 100, 1),
        "caveat": (
            "Curvature results are valid only for the resolvable fraction. In the "
            "blind fraction sharp curves may exist but cannot be measured from this "
            "polyline. Never present the curvature figure as a route-wide measurement."
        ),
    }


def _dt(iso):
    return datetime.fromisoformat(iso) if iso else None


def compute_eta(train=DEFAULT_TRAIN, date=None, weather="clear", max_speed=MAX_SPEED_KMH,
                conflicts=False, conflict_delay_min=0.0):
    """
    Build the per-segment breakdown and total predicted ETA.
    Returns a JSON-serialisable dict (used by both the CLI report and the API).

    `conflicts=True` adds the crossing/overtake hold layer (conflict.py): minutes
    this train is predicted to spend standing in a loop while a higher-precedence
    train passes.  Off by default so every layer number recorded in CLAUDE.md
    §4b stays reproducible, and so a missing corridor cache can never change an
    existing result.
    """
    train_info, stations, sched_src = load_schedule(train, date)

    # Route geometry is optional: curvature needs it, but baseline/dwell/delay/
    # conflicts do not.  Trains from the full corridor dataset have no _route.json.
    try:
        coords = load_route_coords(train)
        cum_km = geometry_cumulative_km(coords)
        geom_len_km = cum_km[-1]
        has_geometry = True
    except FileNotFoundError:
        coords, cum_km, geom_len_km = None, None, None
        has_geometry = False

    halts = [s for s in stations if s.get("isHalt")]
    sched_total_km = halts[-1]["distance"] - halts[0]["distance"]
    # Anchor each halt to a real geometry vertex via its own lat/lng.
    # Only meaningful when we have geometry; without it we still need halt_idx
    # as placeholders but curvature calls will be skipped.
    halt_idx = snap_halts_to_vertices(coords, halts) if has_geometry else list(range(len(halts)))

    wfactor = curvature.WEATHER_SPEED_FACTOR.get(weather, 1.0)
    # INCREMENTAL, not cumulative — delayArrival must be differenced before it can
    # be added per segment (see historical_delay_increment_by_seq).
    hist = historical_delay_increment_by_seq(train)

    segments = []
    sharpest = {"radius_m": math.inf, "lat": None, "segment": None}

    # --- Conflict-hold layer (opt-in) ---------------------------------------
    # Crossings are located on the continuous km axis, but this loop runs over
    # halt-to-halt BLOCKS (11 halts on 12051), and every meet lands at a
    # non-halt block station in between.  So each hold is bucketed into the
    # block whose [d0, d1) km range contains the meet point.
    # Imported lazily: the corridor cache is a separate artifact, and its
    # absence must degrade this one layer, not break the whole model.
    conflict_result, holds_by_block, conflict_error = None, {}, None
    if conflicts:
        try:
            import conflict as conflict_mod
            conflict_result = conflict_mod.find_conflicts(train, conflict_delay_min)
            for c in conflict_result["conflicts"]:
                if c["whoIsHeld"] != "us" or c["ourHoldMin"] <= 0:
                    continue
                for k in range(len(halts) - 1):
                    d0, d1 = halts[k]["distance"], halts[k + 1]["distance"]
                    last = k == len(halts) - 2
                    if d0 <= c["meetKm"] < d1 or (last and c["meetKm"] == d1):
                        holds_by_block.setdefault(k, []).append(c)
                        break
        except Exception as e:                      # noqa: BLE001
            # Reported in the payload rather than silently yielding 0.0 — a
            # zero-valued layer hides its own bugs (VERIFIED #9).
            conflict_error = f"{type(e).__name__}: {e}"

    for k, (a, b) in enumerate(zip(halts[:-1], halts[1:])):
        d0, d1 = a["distance"], b["distance"]
        i0, i1 = halt_idx[k], halt_idx[k + 1]
        dist_km = d1 - d0
        baseline = a.get("speedToNextStationKmph") or max_speed

        if has_geometry:
            # curvature over this halt-to-halt block
            min_r, lat_at = sharpest_radius_in_block(coords, i0, i1)
            curve_cap = max_speed if math.isinf(min_r) else min(max_speed, CURVE_K * math.sqrt(min_r))
            weather_cap = curve_cap * wfactor
            physics_speed = min(max_speed, curve_cap) * wfactor
            effective = min(baseline, curve_cap, weather_cap)
            vrun_min, n_vseg, n_vcap = block_vertex_running_min(
                coords, cum_km, i0, i1, dist_km, baseline, max_speed, wfactor
            )
        else:
            # No route geometry: curvature layer is unavailable for this train.
            # baseline × weather factor is the best speed we can apply.
            min_r, lat_at = math.inf, None
            effective = baseline * wfactor
            curve_cap = max_speed
            weather_cap = effective
            physics_speed = effective
            vrun_min, n_vseg, n_vcap = 0.0, 0, 0

        running_min = dist_km / effective * 60.0
        physics_run_min = dist_km / physics_speed * 60.0

        # dwell at the arriving halt b
        b_arr, b_dep = _dt(b.get("scheduledArrival")), _dt(b.get("scheduledDeparture"))
        dwell_min = max(0.0, (b_dep - b_arr).total_seconds() / 60.0) if (b_arr and b_dep) else 0.0

        # scheduled running time for this block (dep of a -> arr of b)
        a_dep, b_arr2 = _dt(a.get("scheduledDeparture")), _dt(b.get("scheduledArrival"))
        sched_run_min = (b_arr2 - a_dep).total_seconds() / 60.0 if (a_dep and b_arr2) else running_min
        slack_min = max(0.0, sched_run_min - physics_run_min)

        hd_mean, hd_n = hist.get(b["sequence"], (0.0, 0))

        # conflict holds falling inside this block (0.0 unless conflicts=True)
        block_holds = holds_by_block.get(k, [])
        hold_min = sum(c["ourHoldMin"] for c in block_holds)

        seg_eta = running_min + hd_mean + dwell_min + hold_min
        segments.append({
            "from": a["stationCode"], "to": b["stationCode"],
            "from_km": d0, "to_km": d1, "distance_km": round(dist_km, 1),
            "baseline_speed_kmh": round(baseline, 1),
            "min_radius_m": None if math.isinf(min_r) else round(min_r, 1),
            "curve_capped_speed_kmh": round(curve_cap, 1),
            "weather": weather, "weather_capped_speed_kmh": round(weather_cap, 1),
            "effective_speed_kmh": round(effective, 1),
            "running_min": round(running_min, 2),
            "vertex_curve_running_min": round(vrun_min, 2) if has_geometry else None,
            "vertex_segments": n_vseg, "vertex_capped_by_curve": n_vcap,
            "geom_vertex_range": [i0, i1] if has_geometry else None,
            "baseline_only_min": round(dist_km / baseline * 60.0, 2),
            "vertex_curve_penalty_min": round(vrun_min - dist_km / baseline * 60.0, 5) if has_geometry else None,
            "vertex_curve_penalty_sec": round((vrun_min - dist_km / baseline * 60.0) * 60.0, 3) if has_geometry else None,
            "sched_run_min": round(sched_run_min, 1),
            "physics_run_min": round(physics_run_min, 2),
            "schedule_slack_min": round(slack_min, 1),
            "hist_delay_min": round(hd_mean, 2), "hist_delay_samples": hd_n,
            "dwell_min": round(dwell_min, 1),
            "conflict_hold_min": round(hold_min, 1),
            "conflict_holds": [
                {"other_train": c["otherTrain"], "other_type": c["otherType"],
                 "kind": c["kind"], "meet_km": c["meetKm"],
                 "hold_station": c["holdStation"], "hold_min": c["ourHoldMin"]}
                for c in block_holds
            ],
            "segment_eta_min": round(seg_eta, 2),
        })
        if has_geometry and min_r < sharpest["radius_m"]:
            sharpest = {"radius_m": round(min_r, 1), "lat": round(lat_at, 4) if lat_at else None,
                        "segment": f'{a["stationCode"]}→{b["stationCode"]}',
                        "capped_speed_kmh": round(min(max_speed, CURVE_K * math.sqrt(min_r)), 1)}

    total_km = sum(s["distance_km"] for s in segments)
    total_running = sum(s["running_min"] for s in segments)
    total_dwell = sum(s["dwell_min"] for s in segments)
    total_delay = sum(s["hist_delay_min"] for s in segments)
    total_hold = sum(s["conflict_hold_min"] for s in segments)
    total_slack = sum(s["schedule_slack_min"] for s in segments)
    total_eta = sum(s["segment_eta_min"] for s in segments)
    naive_min = total_km / max_speed * 60.0
    sched_duration = train_info.get("duration")
    e2e_samples, e2e_mean = end_to_end_delay_samples(train)

    return {
        "train": train, "train_name": train_info.get("name"),
        "date": date, "weather": weather, "weather_factor": wfactor,
        "max_speed_kmh": max_speed,
        "schedule_source": sched_src,
        "geometry_len_km": round(geom_len_km, 1) if geom_len_km is not None else None,
        "schedule_len_km": round(sched_total_km, 1),
        "segments": segments,
        "totals": {
            "distance_km": round(total_km, 1),
            "naive_flat_speed_min": round(naive_min, 1),
            "running_min": round(total_running, 1),
            "historical_delay_min": round(total_delay, 1),
            "dwell_min": round(total_dwell, 1),
            "conflict_hold_min": round(total_hold, 1),
            "schedule_slack_min": round(total_slack, 1),
            "predicted_eta_min": round(total_eta, 1),
            "scheduled_duration_min": sched_duration,
            "gap_vs_schedule_min": round(total_eta - sched_duration, 1) if sched_duration else None,
        },
        "sharpest_curve": sharpest,
        "curvature_layer_contribution_min": round(
            sum(x["vertex_curve_penalty_min"] for x in segments
                if x["vertex_curve_penalty_min"] is not None), 5) if has_geometry else None,
        "historical_delay_audit": {
            "basis": "incremental (delayArrival differenced along the halt chain)",
            "segment_increments_sum_min": round(total_delay, 1),
            "end_to_end_delay_samples": e2e_samples,
            "end_to_end_delay_mean_min": round(e2e_mean, 1) if e2e_mean is not None else None,
            "coverage_artifact_min": (
                round(total_delay - e2e_mean, 1) if e2e_mean is not None else None),
            "note": (
                "segment_increments_sum should equal end_to_end_delay_mean. Any gap is "
                "a sample-coverage artifact: halts with fewer observed dates make the "
                "sum-of-means diverge from the mean-of-sums. Quote end_to_end_delay_mean "
                "as the measured average delay; the per-segment increments are for "
                "showing WHERE delay accrues, not for a headline number."
            ),
        },
        "geometry_resolution": geometry_resolution(coords) if has_geometry else None,
        "curvature_available": has_geometry,
        # Crossing/overtake hold layer.  Always present so its absence is never
        # ambiguous: `enabled: false` means "not asked for", an `error` means the
        # corridor cache is missing or broken, and 0.0 with enabled=true is a
        # real result (a high-precedence train is held by nobody).
        "conflict_layer": {
            "enabled": bool(conflicts),
            "error": conflict_error,
            "delay_min_applied": conflict_delay_min,
            "total_hold_min": round(total_hold, 1),
            "held_count": (conflict_result or {}).get("heldCount", 0),
            "precedence_count": (conflict_result or {}).get("precedenceCount", 0),
            "conflict_count": len((conflict_result or {}).get("conflicts", [])),
            "note": (
                "Minutes this train is predicted to stand in a loop while a "
                "higher-precedence train passes. 0.0 for a Vande Bharat or "
                "Shatabdi is the CORRECT result, not a wiring failure — they "
                "take precedence over everything else on this corridor."
            ),
            "assumptions": None if not conflict_result else {
                k: (conflict_result["_meta"] or {}).get(k) for k in (
                    "loopBasis", "loopDataIsOfficial", "priorityBasis",
                    "priorityIsOfficial", "reaccelMin", "delayModel",
                    "otherTrainsAreScheduled", "decisionSupportOnly",
                    "singleLineSectionKm", "singleLineBasis",
                )
            },
        },
    }


if __name__ == "__main__":
    import pprint
    pprint.pp(compute_eta())
