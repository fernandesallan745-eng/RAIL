"""
Curvature analysis v3 — corrected parameters for train 22229 (CSMT–Madgaon VB)

Fixes vs v2:
  1. max_train_speed = 80 km/h (actual rated max, not 130)
  2. Halt dwell time summed from (scheduledDeparture - scheduledArrival)
  3. Accel/decel penalty: 45s per speed delta > 15 km/h between segments
  4. Full comparison vs actual 635 min schedule
  5. Bhor Ghat isolation (lat 18.4–18.6)

API responses are cached to .cache/ on first run to conserve quota.
"""

import os, sys, json, math
from datetime import datetime

# ── Load .env ──
with open(os.path.join(os.path.dirname(__file__), ".env")) as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

from railradar_client import RailRadarClient
import curvature

TRAIN = "22229"
CACHE_DIR = os.path.join(os.path.dirname(__file__), ".cache")
os.makedirs(CACHE_DIR, exist_ok=True)

ROUTE_CACHE = os.path.join(CACHE_DIR, f"{TRAIN}_route.json")
LIVE_CACHE = os.path.join(CACHE_DIR, f"{TRAIN}_live.json")


def load_or_fetch():
    """Load from disk cache if available, otherwise fetch from API (once only)."""
    if os.path.exists(ROUTE_CACHE) and os.path.exists(LIVE_CACHE):
        print("  📦 Loading from disk cache (no API calls)")
        with open(ROUTE_CACHE) as f:
            route_raw = json.load(f)
        with open(LIVE_CACHE) as f:
            live_raw = json.load(f)
        return route_raw, live_raw

    print("  🌐 Fetching from RailRadar API (will cache to disk)...")
    client = RailRadarClient()
    route_raw = client.get_route_geometry(TRAIN)
    live_raw = client.get_live_status(TRAIN, geometry=True, geometry_format="geojson")

    with open(ROUTE_CACHE, "w") as f:
        json.dump(route_raw, f)
    with open(LIVE_CACHE, "w") as f:
        json.dump(live_raw, f)
    print("  ✅ Cached to .cache/ — subsequent runs will not call the API")

    return route_raw, live_raw


# ================================================================
#  LOAD DATA
# ================================================================
print("=" * 72)
print("Loading data for train 22229 (CSMT–Madgaon Vande Bharat)")
print("=" * 72)

route_raw, live_raw = load_or_fetch()

# Extract high-res coords: route_raw["geojson"]["geometry"]["coordinates"]
coords = route_raw["geojson"]["geometry"]["coordinates"]  # [lng, lat]
print(f"  GeoJSON coords: {len(coords)} points")

# Extract station schedule from live_raw["route"]
stations = live_raw.get("route", [])
print(f"  Route stations:  {len(stations)}")

train_info = live_raw.get("train", {})
rated_max = train_info.get("maxSpeed", 80)
actual_duration_min = train_info.get("duration", 635)
print(f"  Rated max speed: {rated_max} km/h")
print(f"  Scheduled duration: {actual_duration_min} min")

# ================================================================
#  STEP 1: Curvature profile at 80 km/h (vs previous 130)
# ================================================================
print("\n" + "=" * 72)
print("STEP 1: Segment profile @ 80 km/h (corrected) vs 130 km/h (previous)")
print("=" * 72)

segments_80 = curvature.build_segment_profile(coords, max_train_speed_kmh=80, weather="clear")
segments_130 = curvature.build_segment_profile(coords, max_train_speed_kmh=130, weather="clear")

total_dist_m = sum(s["distance_m"] for s in segments_80)

# Count capped segments
capped_80 = [s for s in segments_80 if s["capped_speed_kmh"] < 80]
capped_130 = [s for s in segments_130 if s["capped_speed_kmh"] < 130]

eta_80_sec = curvature.total_segment_eta(segments_80)
eta_130_sec = curvature.total_segment_eta(segments_130)
naive_80_sec = curvature.naive_eta(total_dist_m, 80)
naive_130_sec = curvature.naive_eta(total_dist_m, 130)

print(f"\n  Route distance: {total_dist_m/1000:.1f} km")
print(f"  Total segments: {len(segments_80)}")
print()
print(f"  {'Metric':<35} {'@ 130 km/h':>12} {'@ 80 km/h':>12}  {'Δ':>8}")
print(f"  {'─'*35} {'─'*12} {'─'*12}  {'─'*8}")
print(f"  {'Segments capped below max':<35} {len(capped_130):>12} {len(capped_80):>12}  {'':>8}")
print(f"  {'Naive ETA (flat speed)':<35} {naive_130_sec/60:>10.1f}m {naive_80_sec/60:>10.1f}m  {'':>8}")
print(f"  {'Curvature-aware ETA':<35} {eta_130_sec/60:>10.1f}m {eta_80_sec/60:>10.1f}m  {'':>8}")
print(f"  {'Curvature penalty':<35} {(eta_130_sec-naive_130_sec)/60:>10.1f}m {(eta_80_sec-naive_80_sec)/60:>10.1f}m  {'':>8}")

print(f"\n  At 80 km/h, curvature adds {(eta_80_sec-naive_80_sec)/60:.1f} min of running time penalty")
print(f"  (vs only {(eta_130_sec-naive_130_sec)/60:.1f} min at 130 — because 80 km/h is already below")
print(f"   most curve caps, so fewer segments are speed-limited)")

# The key insight: at 80 km/h, V_cap = 4.58*sqrt(R) < 80 when R < (80/4.58)^2 = 305m
r_threshold = (80 / 4.58) ** 2
print(f"\n  Curve capping threshold: R < {r_threshold:.0f}m triggers speed reduction at 80 km/h")
print(f"  Segments below that threshold: {len(capped_80)}")

# ================================================================
#  STEP 2: Halt dwell time
# ================================================================
print("\n" + "=" * 72)
print("STEP 2: Halt dwell time from station schedule")
print("=" * 72)

total_dwell_sec = 0
halt_details = []

for s in stations:
    if not s.get("isHalt", False):
        continue

    arr_str = s.get("scheduledArrival")
    dep_str = s.get("scheduledDeparture")

    if arr_str and dep_str:
        try:
            # Parse ISO datetime strings
            arr = datetime.fromisoformat(arr_str)
            dep = datetime.fromisoformat(dep_str)
            dwell = (dep - arr).total_seconds()
            if dwell < 0:
                dwell = 0  # departure before arrival → same time (origin station)
            total_dwell_sec += dwell
            halt_details.append({
                "station": s.get("stationName", s.get("stationCode", "?")),
                "code": s.get("stationCode", "?"),
                "dwell_sec": dwell,
                "arr": arr_str,
                "dep": dep_str,
            })
        except (ValueError, TypeError):
            pass
    elif dep_str and not arr_str:
        # Origin station — no arrival time, dwell = 0
        halt_details.append({
            "station": s.get("stationName", s.get("stationCode", "?")),
            "code": s.get("stationCode", "?"),
            "dwell_sec": 0,
            "arr": "—",
            "dep": dep_str,
        })

print(f"\n  Halts with dwell time:")
print(f"  {'Station':<25} {'Code':>6} {'Dwell':>8}")
print(f"  {'─'*25} {'─'*6} {'─'*8}")
for h in halt_details:
    dwell_str = f"{h['dwell_sec']/60:.0f} min" if h['dwell_sec'] > 0 else "0 (origin)"
    print(f"  {h['station']:<25} {h['code']:>6} {dwell_str:>8}")

print(f"\n  Total halt dwell time: {total_dwell_sec:.0f}s = {total_dwell_sec/60:.1f} min")

# ================================================================
#  STEP 3: Acceleration / deceleration penalty
# ================================================================
print("\n" + "=" * 72)
print("STEP 3: Acceleration/deceleration penalty")
print("=" * 72)

SPEED_DELTA_THRESHOLD = 15  # km/h
ACCEL_PENALTY_SEC = 45      # seconds per event

accel_events = 0
for i in range(1, len(segments_80)):
    speed_prev = segments_80[i - 1]["capped_speed_kmh"]
    speed_curr = segments_80[i]["capped_speed_kmh"]
    if abs(speed_curr - speed_prev) > SPEED_DELTA_THRESHOLD:
        accel_events += 1

accel_penalty_sec = accel_events * ACCEL_PENALTY_SEC

print(f"  Speed-change threshold: >{SPEED_DELTA_THRESHOLD} km/h between consecutive segments")
print(f"  Penalty per event:      {ACCEL_PENALTY_SEC}s")
print(f"  Events detected:        {accel_events}")
print(f"  Total accel/decel penalty: {accel_penalty_sec}s = {accel_penalty_sec/60:.1f} min")

# ================================================================
#  STEP 4: Full comparison vs 635 min schedule
# ================================================================
print("\n" + "=" * 72)
print("STEP 4: Full ETA comparison vs actual 635-minute schedule")
print("=" * 72)

running_time_sec = eta_80_sec
total_eta_sec = running_time_sec + total_dwell_sec + accel_penalty_sec
total_eta_min = total_eta_sec / 60

print(f"""
  ┌──────────────────────────────────────────────────────────────┐
  │  COMPONENT BREAKDOWN                                         │
  ├──────────────────────────────────┬───────────┬───────────────┤
  │  Component                       │  Seconds  │    Minutes    │
  ├──────────────────────────────────┼───────────┼───────────────┤
  │  Running time (curvature-aware)  │ {running_time_sec:>8.0f}  │ {running_time_sec/60:>10.1f} min │
  │  Halt dwell time                 │ {total_dwell_sec:>8.0f}  │ {total_dwell_sec/60:>10.1f} min │
  │  Accel/decel penalty             │ {accel_penalty_sec:>8.0f}  │ {accel_penalty_sec/60:>10.1f} min │
  ├──────────────────────────────────┼───────────┼───────────────┤
  │  OUR PREDICTED TOTAL             │ {total_eta_sec:>8.0f}  │ {total_eta_min:>10.1f} min │
  │  ACTUAL SCHEDULED TOTAL          │ {actual_duration_min*60:>8.0f}  │ {actual_duration_min:>10.1f} min │
  ├──────────────────────────────────┼───────────┼───────────────┤
  │  GAP (schedule − predicted)      │ {actual_duration_min*60 - total_eta_sec:>8.0f}  │ {actual_duration_min - total_eta_min:>10.1f} min │
  └──────────────────────────────────┴───────────┴───────────────┘
""")

gap_min = actual_duration_min - total_eta_min
gap_pct = (gap_min / actual_duration_min) * 100

print(f"  Gap: {gap_min:.1f} min ({gap_pct:.1f}% of scheduled duration)")
print(f"  This remaining gap likely comes from:")
print(f"    - Speed restrictions (TSRs) not in the geometry data")
print(f"    - Pathing delays / signal waits at major junctions")
print(f"    - Slower approach speeds into stations (last-mile braking)")
print(f"    - Track condition / monsoon speed limits")
print(f"    - The train doesn't actually sustain 80 km/h on all segments")

# ── Before vs After comparison ──
print(f"\n  ── BEFORE vs AFTER ──")
print(f"  {'':>3} {'Metric':<40} {'Before (v2)':>12} {'After (v3)':>12}")
print(f"  {'':>3} {'─'*40} {'─'*12} {'─'*12}")
print(f"  {'':>3} {'Max speed used':<40} {'130 km/h':>12} {'80 km/h':>12}")
print(f"  {'':>3} {'Running time':<40} {eta_130_sec/60:>10.1f}m {running_time_sec/60:>10.1f}m")
print(f"  {'':>3} {'Halt dwell':<40} {'0.0m':>12} {total_dwell_sec/60:>10.1f}m")
print(f"  {'':>3} {'Accel/decel penalty':<40} {'0.0m':>12} {accel_penalty_sec/60:>10.1f}m")
print(f"  {'':>3} {'TOTAL PREDICTED':<40} {eta_130_sec/60:>10.1f}m {total_eta_min:>10.1f}m")
print(f"  {'':>3} {'Actual schedule':<40} {'635.0m':>12} {'635.0m':>12}")
print(f"  {'':>3} {'Gap':<40} {635-eta_130_sec/60:>10.1f}m {gap_min:>10.1f}m")
print(f"  {'':>3} {'Gap closed':<40} {'':>12} {635-eta_130_sec/60 - gap_min:>10.1f}m")

# ================================================================
#  STEP 5: Bhor Ghat / Panvel stretch isolation (lat 18.4–18.6)
# ================================================================
print("\n\n" + "=" * 72)
print("STEP 5: Bhor Ghat / Panvel stretch isolation (lat 18.4–18.6)")
print("=" * 72)

GHAT_LAT_MIN = 18.4
GHAT_LAT_MAX = 18.6

ghat_segments = []
for s in segments_80:
    lat_from = s["from"][0]
    lat_to = s["to"][0]
    if GHAT_LAT_MIN <= lat_from <= GHAT_LAT_MAX or GHAT_LAT_MIN <= lat_to <= GHAT_LAT_MAX:
        ghat_segments.append(s)

ghat_capped = [s for s in ghat_segments if s["capped_speed_kmh"] < 80]
ghat_dist_m = sum(s["distance_m"] for s in ghat_segments)
ghat_eta_sec = sum(s["eta_seconds"] for s in ghat_segments)
ghat_naive_sec = curvature.naive_eta(ghat_dist_m, 80) if ghat_dist_m > 0 else 0

print(f"\n  Ghat section (lat {GHAT_LAT_MIN}–{GHAT_LAT_MAX}):")
print(f"    Total segments:       {len(ghat_segments)}")
print(f"    Segments capped < 80: {len(ghat_capped)}")
print(f"    Distance:             {ghat_dist_m/1000:.2f} km")
print(f"    Curvature-aware ETA:  {ghat_eta_sec:.1f}s = {ghat_eta_sec/60:.2f} min")
print(f"    Naive ETA (flat 80):  {ghat_naive_sec:.1f}s = {ghat_naive_sec/60:.2f} min")
print(f"    Curvature penalty:    {(ghat_eta_sec-ghat_naive_sec):.1f}s = {(ghat_eta_sec-ghat_naive_sec)/60:.2f} min")

if ghat_capped:
    sharpest_ghat = sorted(ghat_capped, key=lambda s: s["radius_m"])
    print(f"\n    Sharpest curves in the Ghat stretch:")
    print(f"    {'#':>4} {'radius_m':>10} {'capped_speed':>14} {'distance_m':>12} {'lat':>10}")
    print(f"    {'─'*4} {'─'*10} {'─'*14} {'─'*12} {'─'*10}")
    for idx, s in enumerate(sharpest_ghat[:10], 1):
        print(f"    {idx:>4} {s['radius_m']:>10.1f} {s['capped_speed_kmh']:>12.1f}km/h {s['distance_m']:>12.1f} {s['from'][0]:>10.5f}")

    print(f"""
    ┌─────────────────────────────────────────────────────────────────────┐
    │  BHOR GHAT DEMO EXAMPLE                                            │
    │                                                                     │
    │  Distance through Ghat:  {ghat_dist_m/1000:>6.2f} km                              │
    │  Sharpest curve:         R = {sharpest_ghat[0]['radius_m']:>6.0f} m                             │
    │  Speed at sharpest:      {sharpest_ghat[0]['capped_speed_kmh']:>6.1f} km/h  (vs 80 km/h rated max)    │
    │  Time at full speed:     {ghat_naive_sec/60:>6.2f} min                             │
    │  Time with curvature:    {ghat_eta_sec/60:>6.2f} min                             │
    │  Extra time from curves: {(ghat_eta_sec-ghat_naive_sec)/60:>6.2f} min (+{((ghat_eta_sec-ghat_naive_sec)/ghat_naive_sec*100) if ghat_naive_sec > 0 else 0:.1f}%)                  │
    │                                                                     │
    │  → This is the USP: existing trackers miss this entirely.           │
    └─────────────────────────────────────────────────────────────────────┘""")

# Speed profile through Ghat
print(f"\n    Speed profile through Bhor Ghat (every 3rd segment):")
print(f"    {'lat':>10} {'lng':>10} {'speed':>8} {'radius':>10} {'bar'}")
for i, s in enumerate(ghat_segments):
    if i % 3 == 0 or s["capped_speed_kmh"] < 80:
        r_str = f"{s['radius_m']:.0f}m" if s["radius_m"] is not None else "∞"
        bar_len = int(s["capped_speed_kmh"] / 2)
        bar = "█" * bar_len
        capped_marker = " ◀ CAPPED" if s["capped_speed_kmh"] < 80 else ""
        print(f"    {s['from'][0]:>10.5f} {s['from'][1]:>10.5f} {s['capped_speed_kmh']:>6.1f} {r_str:>10} {bar}{capped_marker}")

print("\n\nDone.")
