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
import corridor_geometry as cgeom

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


def load_route_coords(train=DEFAULT_TRAIN, hires=False):
    """[lng,lat] geometry from the /route endpoint cache (extra 'geojson' wrapper).
    If hires=True, loads {train}_route_hires.json if present (spline-densified to <=100m).
    """
    if hires:
        hpath = os.path.join(CACHE, f"{train}_route_hires.json")
        if os.path.exists(hpath):
            data = _load(hpath)
            if "data" in data and "geojson" in data["data"]:
                return data["data"]["geojson"]["geometry"]["coordinates"]
            if "geojson" in data:
                return data["geojson"]["geometry"]["coordinates"]

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
    5. Normalised corridor cache (.cache/corridor/{train}.json), built by
       scripts/build_corridor.py from an older live fallback file.  Reached only
       by trains that were cached once but are not in the Konkan roster —
       12989, 22195 and 22308 raised FileNotFoundError here despite having a
       complete schedule on disk, because step 4 was the end of the chain.
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
    try:
        return _load_schedule_from_full_dataset(train)
    except FileNotFoundError as e:
        # Then the normalised corridor cache.  Ordered last because it is the
        # thinnest source: no `section`/`kmFromRoha`, no pass-through rows.
        out = _load_schedule_from_corridor_cache(train)
        if out is None:
            raise FileNotFoundError(f"{e} No .cache/corridor/{train}.json either.")
        return out


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


def _load_schedule_from_corridor_cache(train):
    """Adapt `.cache/corridor/{train}.json` to (train_info, stations, source).

    That file stores day-normalised minutes (VERIFIED #16), not ISO strings, so
    the times are re-expressed against the same `_REF_DATE` the full-dataset
    adapter uses.  The service date is deliberately not recovered — it was
    discarded on purpose when the file was built, and `compute_eta` only ever
    uses these timestamps for *differences*.

    Returns None (not an exception) when the file is absent, so the caller can
    report both misses in one message.
    """
    path = os.path.join(CACHE, "corridor", f"{train}.json")
    if not os.path.exists(path):
        return None
    j = _load(path)

    def _iso(mins):
        if mins is None:
            return None
        return (_REF_DATE + timedelta(minutes=int(mins))).isoformat()

    stations = []
    for i, s in enumerate(j.get("stations") or []):
        if s.get("km") is None:
            continue
        stations.append({
            "stationCode":        s["code"],
            "stationName":        s.get("name", ""),
            "distance":           float(s["km"]),
            "sequence":           i,
            "isHalt":             bool(s.get("isHalt")),
            "scheduledArrival":   _iso(s.get("arrMin")),
            "scheduledDeparture": _iso(s.get("depMin")),
            "lat":                s.get("lat"),
            "lng":                s.get("lng"),
        })
    if len(stations) < 2:
        return None

    halts = [s for s in stations if s.get("isHalt")]
    for k in range(len(halts) - 1):
        a, b = halts[k], halts[k + 1]
        a_dep, b_arr = _dt(a.get("scheduledDeparture")), _dt(b.get("scheduledArrival"))
        dist = b["distance"] - a["distance"]
        speed = None
        if a_dep and b_arr and dist > 0:
            run_min = (b_arr - a_dep).total_seconds() / 60.0
            speed = dist / run_min * 60.0 if run_min > 0 else None
        for s in stations:
            if a["distance"] <= s["distance"] < b["distance"]:
                s["speedToNextStationKmph"] = speed

    duration = None
    if halts and halts[0].get("scheduledDeparture") and halts[-1].get("scheduledArrival"):
        d0, a1 = _dt(halts[0]["scheduledDeparture"]), _dt(halts[-1]["scheduledArrival"])
        if d0 and a1:
            duration = round((a1 - d0).total_seconds() / 60.0)

    return ({"name": j.get("name"), "number": j.get("number"), "duration": duration},
            stations, f"corridor/{train}.json")


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


def compute_quantile(values, p):
    """
    Computes quantile p (0.0 to 1.0) with linear interpolation between ranks.
    Matches standard numpy.percentile / scipy quantile conventions.
    """
    if not values:
        return 0.0
    s = sorted(values)
    n = len(s)
    if n == 1:
        return float(s[0])
    idx = (n - 1) * p
    low = int(math.floor(idx))
    high = int(math.ceil(idx))
    if low == high:
        return float(s[low])
    weight = idx - low
    return float(s[low] * (1.0 - weight) + s[high] * weight)


def segment_delay_distributions(train=DEFAULT_TRAIN):
    """
    Statistical distributions of INCREMENTAL delay (minutes) per halt sequence.
    Returns:
    {
        seq: {
            "mean": float,
            "median": float, # p50
            "p80": float,
            "p95": float,
            "std": float,
            "min": float,
            "max": float,
            "n": int,
            "samples": list[float]
        }
    }
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
            acc.setdefault(s["sequence"], []).append(float(da - prev))
            prev = da

    dist = {}
    for seq, v in acc.items():
        n = len(v)
        mean_v = sum(v) / n
        var_v = sum((x - mean_v) ** 2 for x in v) / n if n > 1 else 0.0
        dist[seq] = {
            "mean": round(mean_v, 2),
            "median": round(compute_quantile(v, 0.50), 2),
            "p80": round(compute_quantile(v, 0.80), 2),
            "p95": round(compute_quantile(v, 0.95), 2),
            "std": round(math.sqrt(var_v), 2),
            "min": round(min(v), 2),
            "max": round(max(v), 2),
            "n": n,
            "samples": v,
        }
    return dist


def historical_delay_increment_by_seq(train=DEFAULT_TRAIN, quantile="mean"):
    """
    Incremental delay (minutes) added on the approach to each halt, parameterized
    by quantile ("mean", "p50"/"median", "p80", "p95").

    Returns {seq: (increment_min, n_samples)}.
    Defaults to "mean" to maintain 100% backward compatibility.
    """
    dist = segment_delay_distributions(train)
    out = {}
    q_key = "mean"
    if quantile in ("p50", "median"):
        q_key = "median"
    elif quantile == "p80":
        q_key = "p80"
    elif quantile == "p95":
        q_key = "p95"

    for seq, stats in dist.items():
        val = stats.get(q_key, stats["mean"])
        out[seq] = (val, stats["n"])
    return out


def compute_confidence_bands(train=DEFAULT_TRAIN, mode="vertex", weather="live"):
    """
    Computes calibrated arrival confidence bands for the journey by evaluating
    the physics and delay models under median (p50), mean, conservative (p80),
    and stress (p95) historical delay quantiles.
    """
    dist = segment_delay_distributions(train)
    if not dist:
        return {
            "available": False,
            "unavailable_reason": "no-dated-runs-cached",
            "sample_count": 0,
            "note": "No dated runs with real delay signals are cached for this train.",
        }

    tot_p50 = sum(s["median"] for s in dist.values())
    tot_mean = sum(s["mean"] for s in dist.values())
    tot_p80 = sum(s["p80"] for s in dist.values())
    tot_p95 = sum(s["p95"] for s in dist.values())
    sample_sizes = [s["n"] for s in dist.values()]
    n_eff = max(sample_sizes) if sample_sizes else 0

    return {
        "available": True,
        "sample_count": n_eff,
        "p50_delay_min": round(tot_p50, 1),
        "mean_delay_min": round(tot_mean, 1),
        "p80_delay_min": round(tot_p80, 1),
        "p95_delay_min": round(tot_p95, 1),
        "uncertainty_min_80": round(max(0.0, (tot_p80 - tot_p50) / 2.0), 1),
        "uncertainty_min_95": round(max(0.0, (tot_p95 - tot_p50) / 2.0), 1),
        "uncertainty_band_80_min": round(max(0.0, (tot_p80 - tot_p50) / 2.0), 1),
        "uncertainty_band_95_min": round(max(0.0, (tot_p95 - tot_p50) / 2.0), 1),
        "confidence_interval_80": [round(tot_p50, 1), round(tot_p80, 1)],
        "confidence_interval_95": [round(tot_p50, 1), round(tot_p95, 1)],
        "basis": "empirical-segment-quantile-distribution",
        "note": f"Calibrated across {n_eff} historical completed runs with genuine delay signal.",
    }


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


def observed_band(train=DEFAULT_TRAIN, predicted_eta_min=None):
    """
    The spread of ACTUALLY OBSERVED journey durations, carried onto the prediction.

    VERIFIED #10 is explicit that a single accuracy number off a small sample mean
    oversells the model, so the spread must reach the UI rather than being computed
    and discarded. What is returned here is the measured range and quantile anchors.
    """
    samples, _ = end_to_end_delay_samples(train)
    info, _, _ = load_schedule(train)
    sched = info.get("duration")

    if not samples or sched is None:
        return {
            "available": False,
            "sample_count": len(samples),
            "unavailable_reason": (
                "no-dated-runs-cached" if not samples else "no-scheduled-duration"),
            "note": (
                "No observed runs are cached for this train, so its spread is unknown "
                "— not zero. Only the reference train has dated historical runs; "
                "fetch_dates.py adds more."),
        }
    if len(samples) < 2:
        return {
            "available": False,
            "sample_count": len(samples),
            "unavailable_reason": "insufficient-samples",
            "note": "A single observed run has no spread to measure.",
        }

    durations = {d: sched + v for d, v in samples.items()}
    vals = sorted(durations.values())
    obs_mean = sum(vals) / len(vals)
    devs = [v - obs_mean for v in vals]
    low_dev, high_dev = min(devs), max(devs)

    out = {
        "available": True,
        "sample_count": len(vals),
        "basis": "observed-range",
        "observed_durations_min": durations,
        "observed_mean_min": round(obs_mean, 1),
        "observed_min_min": vals[0],
        "observed_max_min": vals[-1],
        "p50_duration_min": round(compute_quantile(vals, 0.50), 1),
        "p80_duration_min": round(compute_quantile(vals, 0.80), 1),
        "p95_duration_min": round(compute_quantile(vals, 0.95), 1),
        "observed_spread_min": round(vals[-1] - vals[0], 1),
        "minus_min": round(-low_dev, 1),
        "plus_min": round(high_dev, 1),
        "scheduled_duration_min": sched,
        "note": (
            f"Range of {len(vals)} observed runs with empirical quantile anchors. "
            f"Width is the measured spread about the observed mean ({round(obs_mean, 1)} min); "
            f"the centre is the model's own prediction."
        ),
    }
    if predicted_eta_min is not None:
        out["band_low_min"] = round(predicted_eta_min + low_dev, 1)
        out["band_high_min"] = round(predicted_eta_min + high_dev, 1)
        out["centre_min"] = round(predicted_eta_min, 1)
        out["error_vs_observed_mean_min"] = round(predicted_eta_min - obs_mean, 1)
    return out


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


def _shared_geometry_resolution(block_geom):
    """Curvature-blind fraction over the vertex spans actually used.

    On the shared path there is no single polyline for the train, so resolution
    is measured over the union of the clipped ranges rather than over a whole
    reference route — otherwise a Madgaon-Karwar train would inherit the
    blindness statistic of the entire CSMT-Madgaon polyline.
    """
    used = [b for b in block_geom if b is not None]
    if not used:
        return None
    merged = []
    for bcoords, _bcum, i0, i1, _ref in used:
        merged.extend(bcoords[i0:i1 + 1])
    if len(merged) < 3:
        return None
    return geometry_resolution(merged)


def compute_eta(train=DEFAULT_TRAIN, date=None, weather="clear", max_speed=MAX_SPEED_KMH,
                conflicts=False, conflict_delay_min=0.0, conflict_service_date=None,
                hazards=False, hazard_store_path=None, quantile="mean"):
    """
    Build the per-segment breakdown and total predicted ETA.
    Returns a JSON-serialisable dict (used by both the CLI report and the API).

    `quantile` allows choosing between "mean" (default, expected value),
    "p50" / "median" (optimistic/median baseline), "p80" (conservative operational
    planning buffer), and "p95" (stress/worst-case buffer).

    `conflicts=True` adds the crossing/overtake hold layer (conflict.py): minutes
    this train is predicted to spend standing in a loop while a higher-precedence
    train passes.

    `hazards=True` adds the crowdsourced-hazard speed-restriction layer (hazard_layer.py).
    """
    train_info, stations, sched_src = load_schedule(train, date)

    halts = [s for s in stations if s.get("isHalt")]
    sched_total_km = halts[-1]["distance"] - halts[0]["distance"]

    geom_basis, geom_shared = None, None
    coords, cum_km, geom_len_km = None, None, None
    try:
        coords = load_route_coords(train)
        cum_km = geometry_cumulative_km(coords)
        geom_len_km = cum_km[-1]
        geom_basis = "own-route"
        halt_idx = snap_halts_to_vertices(coords, halts)
        block_geom = [
            (coords, cum_km, halt_idx[k], halt_idx[k + 1], train)
            if halt_idx[k + 1] - halt_idx[k] >= 2 else None
            for k in range(len(halts) - 1)
        ]
    except FileNotFoundError:
        geom_shared = cgeom.route_for(halts)
        block_geom = geom_shared["blocks"]
        geom_basis = geom_shared["basis"]
        halt_idx = list(range(len(halts)))

    has_geometry = any(b is not None for b in block_geom)

    is_live_weather = (weather == "live")
    route_weather_data = {}

    if is_live_weather:
        try:
            import weather_service
            weather_points = []
            for k, (a, b) in enumerate(zip(halts[:-1], halts[1:])):
                lat_a = a.get("lat") or (a.get("station") or {}).get("lat")
                lng_a = a.get("lng") or (a.get("station") or {}).get("lng")
                lat_b = b.get("lat") or (b.get("station") or {}).get("lat")
                lng_b = b.get("lng") or (b.get("station") or {}).get("lng")
                if lat_a and lng_a:
                    weather_points.append((float(lat_a), float(lng_a)))
                if lat_b and lng_b:
                    weather_points.append((float(lat_b), float(lng_b)))
            if weather_points:
                route_weather_data = weather_service.get_batch_weather(weather_points, max_train_speed_kmh=max_speed)
        except Exception:
            route_weather_data = {}

    default_wfactor = 1.0 if is_live_weather else curvature.WEATHER_SPEED_FACTOR.get(weather, 1.0)
    # INCREMENTAL, not cumulative — delayArrival must be differenced before it can
    # be added per segment (see historical_delay_increment_by_seq).
    hist = historical_delay_increment_by_seq(train, quantile=quantile)
    dist_map = segment_delay_distributions(train)

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
            # The service date decides WHICH other trains are on the corridor:
            # only 59 of the 206 roster trains run daily.  It defaults to the
            # schedule date being modelled, so an /eta for a Monday is not
            # charged a crossing with a Thursday-only special.
            conflict_result = conflict_mod.find_conflicts(
                train, conflict_delay_min,
                service_date=conflict_service_date if conflict_service_date is not None else date,
                use_live_delays=True, dynamic_feedback=True)
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

    # --- Crowdsourced-hazard speed-restriction layer (opt-in) ----------------
    # Confirmed hazard reports become km spans with a capped speed on this
    # train's own timetable axis.  The penalty is charged on the OVERLAP between
    # each span and each block, so a 1 km landslide costs 1 km of restriction
    # even inside the 175 km PNVL→KHED block.  See hazard_layer's header for why
    # this is an additive overlap term rather than a fold into the per-vertex
    # curvature loop.
    # Lazily imported for the same reason as `conflict`: the store is a separate
    # artifact and its absence must degrade one layer, not the whole model.
    hazard_result, hazard_error = None, None
    if hazards:
        try:
            import hazard_layer as hazard_mod
            hazard_result = hazard_mod.build(train, stations, path=hazard_store_path)
        except Exception as e:                      # noqa: BLE001
            hazard_error = f"{type(e).__name__}: {e}"
    hazard_spans = (hazard_result or {}).get("spans", [])

    for k, (a, b) in enumerate(zip(halts[:-1], halts[1:])):
        d0, d1 = a["distance"], b["distance"]
        dist_km = d1 - d0
        baseline = a.get("speedToNextStationKmph") or max_speed

        # Block-specific weather resolution
        if is_live_weather:
            import weather_service
            lat_a = a.get("lat") or (a.get("station") or {}).get("lat")
            lng_a = a.get("lng") or (a.get("station") or {}).get("lng")
            lat_b = b.get("lat") or (b.get("station") or {}).get("lat")
            lng_b = b.get("lng") or (b.get("station") or {}).get("lng")
            target_pt = (float(lat_b), float(lng_b)) if (lat_b and lng_b) else ((float(lat_a), float(lng_a)) if (lat_a and lng_a) else None)

            block_wx = None
            if target_pt and target_pt in route_weather_data:
                block_wx = route_weather_data[target_pt]
            elif target_pt:
                block_wx = weather_service.get_point_weather(target_pt[0], target_pt[1], max_train_speed_kmh=max_speed)
            if not block_wx:
                block_wx = weather_service.fallback_weather("block-default")

            wfactor = block_wx["factor"]
            block_weather_info = block_wx
        else:
            wfactor = default_wfactor
            block_weather_info = {
                "factor": wfactor,
                "condition": weather,
                "precip_mm_h": 0.0,
                "temp_c": None,
                "visibility_m": 10000.0,
                "wmo_code": 0,
                "wmo_description": weather,
                "basis": "static-simulation",
            }

        bg = block_geom[k]
        seg_geom = bg is not None
        if seg_geom:
            bcoords, bcum, i0, i1, bref = bg
            # curvature over this halt-to-halt block
            min_r, lat_at = sharpest_radius_in_block(bcoords, i0, i1)
            curve_cap = max_speed if math.isinf(min_r) else min(max_speed, CURVE_K * math.sqrt(min_r))
            weather_cap = curve_cap * wfactor
            physics_speed = min(max_speed, curve_cap) * wfactor
            effective = min(baseline, curve_cap, weather_cap)
            vrun_min, n_vseg, n_vcap = block_vertex_running_min(
                bcoords, bcum, i0, i1, dist_km, baseline, max_speed, wfactor
            )
        else:
            i0 = i1 = None
            bref = None
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

        # hazard restrictions overlapping this block (0.0 unless hazards=True).
        # Charged against `effective` — the speed this block would otherwise run
        # at — so the layer reports only the EXTRA minutes the restriction costs,
        # and a cap looser than the block's own speed correctly contributes 0.0.
        hazard_min, hazard_detail = (0.0, [])
        if hazard_spans:
            import hazard_layer as hazard_mod
            hazard_min, hazard_detail = hazard_mod.block_penalty_min(
                hazard_spans, d0, d1, effective)

        seg_eta = running_min + hd_mean + dwell_min + hold_min + hazard_min
        seg_dict = {
            "from": a["stationCode"], "to": b["stationCode"],
            "from_km": d0, "to_km": d1, "distance_km": round(dist_km, 1),
            "baseline_speed_kmh": round(baseline, 1),
            "min_radius_m": None if math.isinf(min_r) else round(min_r, 1),
            "curve_capped_speed_kmh": round(curve_cap, 1),
            "weather": block_weather_info["condition"],
            "weather_factor": round(wfactor, 3),
            "weather_telemetry": block_weather_info,
            "weather_capped_speed_kmh": round(weather_cap, 1),
            "effective_speed_kmh": round(effective, 1),
            "running_min": round(running_min, 2),
            "vertex_curve_running_min": round(vrun_min, 2) if seg_geom else None,
            "vertex_segments": n_vseg, "vertex_capped_by_curve": n_vcap,
            "geom_vertex_range": [i0, i1] if seg_geom else None,
            # Which polyline this block's curvature actually came from, and on
            # what basis.  None means this block has no alignment available —
            # NOT that it is straight.
            "curvature_available": seg_geom,
            "geometry_basis": (geom_basis if seg_geom else None),
            "geometry_reference_train": bref,
            "baseline_only_min": round(dist_km / baseline * 60.0, 2),
            "vertex_curve_penalty_min": round(vrun_min - dist_km / baseline * 60.0, 5) if seg_geom else None,
            "vertex_curve_penalty_sec": round((vrun_min - dist_km / baseline * 60.0) * 60.0, 3) if seg_geom else None,
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
            "hazard_penalty_min": round(hazard_min, 3),
            "hazard_restrictions": hazard_detail,
            "hazard_basis": sorted({rid for h in hazard_detail for rid in h["report_ids"]}) or None,
            "segment_eta_min": round(seg_eta, 2),
        }

        s_stats = dist_map.get(b["sequence"])
        if s_stats:
            seg_dict["delay_distribution"] = {
                "median_min": s_stats["median"],
                "mean_min": s_stats["mean"],
                "p80_min": s_stats["p80"],
                "p95_min": s_stats["p95"],
                "std_min": s_stats["std"],
                "sample_count": s_stats["n"],
            }

        segments.append(seg_dict)
        if seg_geom and min_r < sharpest["radius_m"]:
            sharpest = {"radius_m": round(min_r, 1), "lat": round(lat_at, 4) if lat_at else None,
                        "segment": f'{a["stationCode"]}→{b["stationCode"]}',
                        "capped_speed_kmh": round(min(max_speed, CURVE_K * math.sqrt(min_r)), 1)}

    total_km = sum(s["distance_km"] for s in segments)
    total_running = sum(s["running_min"] for s in segments)
    total_dwell = sum(s["dwell_min"] for s in segments)
    total_delay = sum(s["hist_delay_min"] for s in segments)
    total_hold = sum(s["conflict_hold_min"] for s in segments)
    total_hazard = sum(s["hazard_penalty_min"] for s in segments)
    total_slack = sum(s["schedule_slack_min"] for s in segments)
    total_eta = sum(s["segment_eta_min"] for s in segments)
    naive_min = total_km / max_speed * 60.0
    sched_duration = train_info.get("duration")
    e2e_samples, e2e_mean = end_to_end_delay_samples(train)

    avg_wfactor = round(sum(s.get("weather_factor", 1.0) for s in segments) / len(segments), 3) if segments else 1.0

    cb = compute_confidence_bands(train=train, mode="vertex", weather=weather)
    if cb["available"]:
        base_non_delay = total_running + total_dwell + total_hold + total_hazard
        cb["p50_eta_min"] = round(base_non_delay + cb["p50_delay_min"], 1)
        cb["mean_eta_min"] = round(base_non_delay + cb["mean_delay_min"], 1)
        cb["p80_eta_min"] = round(base_non_delay + cb["p80_delay_min"], 1)
        cb["p95_eta_min"] = round(base_non_delay + cb["p95_delay_min"], 1)
        cb["confidence_interval_80_eta"] = [cb["p50_eta_min"], cb["p80_eta_min"]]
        cb["confidence_interval_95_eta"] = [cb["p50_eta_min"], cb["p95_eta_min"]]

    return {
        "train": train, "train_name": train_info.get("name"),
        "date": date,
        "quantile": quantile,
        "weather": weather,
        "weather_mode": "live-geofenced" if is_live_weather else "static-simulation",
        "weather_factor": avg_wfactor if is_live_weather else default_wfactor,
        "weather_summary": {
            "mode": "live-geofenced" if is_live_weather else "static-simulation",
            "adverse_blocks": sum(1 for s in segments if s.get("weather_factor", 1.0) < 0.99),
            "min_factor": min((s.get("weather_factor", 1.0) for s in segments), default=1.0),
            "max_precip_mm_h": max((s.get("weather_telemetry", {}).get("precip_mm_h", 0.0) for s in segments), default=0.0),
            "conditions": sorted(list({s.get("weather") for s in segments})),
        },
        "max_speed_kmh": max_speed,
        "schedule_source": sched_src,
        "quantile": quantile,
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
            "hazard_penalty_min": round(total_hazard, 2),
            "schedule_slack_min": round(total_slack, 1),
            "predicted_eta_min": round(total_eta, 1),
            "scheduled_duration_min": sched_duration,
            "gap_vs_schedule_min": round(total_eta - sched_duration, 1) if sched_duration else None,
            "quantile": quantile,
            "confidence_bands": cb,
        },
        "sharpest_curve": (None if math.isinf(sharpest["radius_m"]) else sharpest),
        "curvature_layer_contribution_min": round(
            sum(x["vertex_curve_penalty_min"] for x in segments
                if x["vertex_curve_penalty_min"] is not None), 5) if has_geometry else None,
        "curvature_layer_covers_km": round(sum(
            s["distance_km"] for s, b in zip(segments, block_geom)
            if b is not None), 1),
        "observed_band": observed_band(train, round(total_eta, 1)),
        "historical_delay_audit": {
            "basis": "incremental (delayArrival differenced along the halt chain)",
            "segment_increments_sum_min": round(total_delay, 1),
            "end_to_end_delay_samples": e2e_samples,
            "end_to_end_delay_mean_min": round(e2e_mean, 1) if e2e_mean is not None else None,
            "coverage_artifact_min": (
                round(total_delay - e2e_mean, 1) if e2e_mean is not None else None),
            "distribution_summary": {
                "p50_min": round(sum(s["median"] for s in dist_map.values()), 1) if dist_map else 0.0,
                "mean_min": round(sum(s["mean"] for s in dist_map.values()), 1) if dist_map else 0.0,
                "p80_min": round(sum(s["p80"] for s in dist_map.values()), 1) if dist_map else 0.0,
                "p95_min": round(sum(s["p95"] for s in dist_map.values()), 1) if dist_map else 0.0,
            },
            "note": (
                "segment_increments_sum should equal end_to_end_delay_mean. Any gap is "
                "a sample-coverage artifact: halts with fewer observed dates make the "
                "sum-of-means diverge from the mean-of-sums."
            ),
        },
        # Resolution is measured on the polyline that was actually used.  On
        # the shared path that is the reference's own geometry, so the
        # "resolvable ~44%" caveat of VERIFIED #8 is recomputed per reference
        # rather than inherited.
        "geometry_resolution": (
            geometry_resolution(coords) if coords is not None else
            _shared_geometry_resolution(block_geom)
        ),
        "curvature_available": has_geometry,
        "geometry_basis": geom_basis,
        "geometry_coverage": (
            {"blocks_resolved": sum(1 for b in block_geom if b is not None),
             "blocks_total": len(block_geom),
             "coverage_km": round(sum(
                 s["distance_km"] for s, b in zip(segments, block_geom)
                 if b is not None), 1),
             "total_km": round(total_km, 1),
             "coverage_fraction": (round(sum(
                 s["distance_km"] for s, b in zip(segments, block_geom)
                 if b is not None) / total_km, 4) if total_km else 0.0),
             "reference_trains": sorted({b[4] for b in block_geom if b is not None}),
             "unresolved_blocks": [f'{s["from"]}->{s["to"]}'
                                   for s, b in zip(segments, block_geom)
                                   if b is None],
             "unavailable_reason": (geom_shared or {}).get("unavailableReason"),
             "basis_note": (
                 None if geom_basis != "shared-corridor-polyline" else
                 (geom_shared or {}).get("basisNote")
             )}
        ),
        # Crossing/overtake hold layer.  Always present so its absence is never
        # ambiguous: `enabled: false` means "not asked for", an `error` means the
        # corridor cache is missing or broken, and 0.0 with enabled=true is a
        # real result (a high-precedence train is held by nobody).
        "conflict_layer": {
            "enabled": bool(conflicts),
            "error": conflict_error,
            "delay_min_applied": conflict_delay_min,
            "total_hold_min": round(total_hold, 1),
            "total_cascading_hold_min": (conflict_result or {}).get("totalCascadingHoldMin", 0.0),
            "total_ripple_delay_min": (conflict_result or {}).get("totalRippleDelayMin", 0.0),
            "dynamic_feedback": (conflict_result or {}).get("_meta", {}).get("dynamicFeedback", False),
            "use_live_delays": (conflict_result or {}).get("_meta", {}).get("useLiveDelays", False),
            "cross_train_delays_applied": len(
                (conflict_result or {}).get("_meta", {}).get("otherDelaysApplied", None) or {}),
            "held_count": (conflict_result or {}).get("heldCount", 0),
            "precedence_count": (conflict_result or {}).get("precedenceCount", 0),
            "conflict_count": len((conflict_result or {}).get("conflicts", [])),
            "note": (
                "Minutes this train is predicted to stand in a loop while a "
                "higher-precedence train passes. 0.0 for a Vande Bharat or "
                "Shatabdi is the CORRECT result, not a wiring failure \u2014 they "
                "take precedence over everything else on this corridor."
            ),
            "assumptions": None if not conflict_result else {
                k: (conflict_result["_meta"] or {}).get(k) for k in (
                    "loopBasis", "loopDataIsOfficial", "priorityBasis",
                    "priorityIsOfficial", "reaccelMin", "delayModel",
                    "otherTrainsAreScheduled", "decisionSupportOnly",
                    "singleLineSectionKm", "singleLineBasis",
                    "dynamicFeedback", "useLiveDelays",
                )
            },
        },
        # Crowdsourced-hazard layer.  Always present, for the same reason as
        # conflict_layer: `enabled: false` means "not asked for", `error` means
        # the store is missing or broken, and 0.0 with enabled=true is a real
        # result meaning no human has confirmed a hazard on this route.  Those
        # are three different facts and collapsing them is VERIFIED #9.
        "hazard_layer": {
            "enabled": bool(hazards),
            "error": hazard_error,
            "available": (hazard_result or {}).get("available", False),
            "unavailable_reason": (hazard_result or {}).get("unavailableReason"),
            "total_penalty_min": round(total_hazard, 2),
            "reports_in_store": (hazard_result or {}).get("totalReports", 0),
            "confirmed_reports": (hazard_result or {}).get("confirmedReports", 0),
            "applied_reports": (hazard_result or {}).get("appliedReports", []),
            "restricted_km": (hazard_result or {}).get("restrictedKm", 0.0),
            # The merged km spans on THIS train's own timetable axis.  Published
            # for two reasons: api.py re-charges them against the vertex-mode
            # speed (charging a block-mode penalty into a vertex total is the
            # mode-mixing VERIFIED #27 had to untangle), and the UI can draw the
            # restricted stretch on the route line without re-deriving the axis.
            "spans": (hazard_result or {}).get("spans", []),
            "span_half_width_km": (hazard_result or {}).get("spanHalfWidthKm"),
            "caps_kmph": (hazard_result or {}).get("capsKmph"),
            "skipped": (hazard_result or {}).get("skipped", []),
            "unplaceable": (hazard_result or {}).get("unplaceable", []),
            "off_route": (hazard_result or {}).get("offRoute", []),
            "note": (
                "Minutes lost to temporary speed restrictions derived from "
                "HUMAN-CONFIRMED crowdsourced hazard reports. Machine-scored "
                "reports (logged/candidate/corroborated) never reach this layer. "
                "0.0 with available=true means nobody has confirmed a hazard on "
                "this route — a real zero, not a wiring failure."
            ),
            "assumptions": None if not hazard_result else {
                k: hazard_result.get(k) for k in (
                    "capsAreHeuristic", "capsBasis", "requiresHumanConfirmation",
                    "appliedStatuses", "machineStatusesIgnored",
                    "decisionSupportOnly", "upstreamRequestCost",
                )
            },
        },
    }


if __name__ == "__main__":
    import pprint
    pprint.pp(compute_eta())
