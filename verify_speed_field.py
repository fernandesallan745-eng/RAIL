"""
Verify: is speedToNextStationKmph schedule-derived or live-observed?

Strategy:
  - Call get_live_status("22229", date=X) for 4 past dates
  - Compare speedToNextStationKmph for same station pairs across dates
  - Also compute schedule-derived speed: distance / time_between_stops
  - Report: constant across dates → schedule-derived. Varies → live-observed.

Train 22229 runs Mon/Wed/Fri. Dates chosen across 3+ weeks:
  2026-08-08 (Fri), 2026-08-13 (Wed), 2026-08-18 (Mon), 2026-08-25 (Mon)
"""

import os, json, sys
from datetime import datetime

# Load .env
with open(os.path.join(os.path.dirname(__file__), ".env")) as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

from railradar_client import RailRadarClient

TRAIN = "22229"
DATES = ["2026-08-08", "2026-08-13", "2026-08-18", "2026-08-25"]
CACHE_DIR = os.path.join(os.path.dirname(__file__), ".cache")
os.makedirs(CACHE_DIR, exist_ok=True)

client = RailRadarClient()

# ── Fetch (or load from cache) live status for each date ──
date_data = {}
for d in DATES:
    cache_file = os.path.join(CACHE_DIR, f"{TRAIN}_live_{d}.json")
    if os.path.exists(cache_file):
        print(f"  📦 {d}: loading from cache")
        with open(cache_file) as f:
            date_data[d] = json.load(f)
    else:
        print(f"  🌐 {d}: fetching from API...")
        try:
            data = client.get_live_status(TRAIN, date=d, geometry=False)
            with open(cache_file, "w") as f:
                json.dump(data, f)
            date_data[d] = data
            print(f"       ✅ cached")
        except Exception as e:
            print(f"       ❌ {type(e).__name__}: {e}")
            date_data[d] = None

# ── Extract route stations for each date ──
print("\n" + "=" * 80)
print("STEP 1: Raw speedToNextStationKmph for ALL stations, across 4 dates")
print("=" * 80)

# Use first available date to get station list
ref_date = None
for d in DATES:
    if date_data[d] and "route" in date_data[d]:
        ref_date = d
        break

if not ref_date:
    print("No valid data found for any date!")
    sys.exit(1)

ref_route = date_data[ref_date]["route"]
# Show station codes
print(f"\nReference date: {ref_date}")
print(f"Stations: {len(ref_route)}")

# Build comparison table for the first ~20 halt stations
halt_stations = [s for s in ref_route if s.get("isHalt")]
# Also include some non-halt for comparison
compare_stations = ref_route[:30]  # first 30 stations

# Print header
col_width = 12
print(f"\n{'seq':>4} {'code':>6} {'halt':>5} {'dist':>5}", end="")
for d in DATES:
    short = d[5:]  # MM-DD
    print(f"  {'spd_'+short:>{col_width}}", end="")
print(f"  {'all_same?':>10}")
print(f"{'─'*4} {'─'*6} {'─'*5} {'─'*5}", end="")
for _ in DATES:
    print(f"  {'─'*col_width}", end="")
print(f"  {'─'*10}")

for station in compare_stations:
    seq = station["sequence"]
    code = station.get("stationCode", "?")
    is_halt = "✓" if station.get("isHalt") else ""
    dist = station.get("distance", "?")

    speeds = []
    for d in DATES:
        if date_data[d] and "route" in date_data[d]:
            route = date_data[d]["route"]
            match = next((s for s in route if s["sequence"] == seq), None)
            if match and match.get("speedToNextStationKmph") is not None:
                speeds.append(match["speedToNextStationKmph"])
            else:
                speeds.append(None)
        else:
            speeds.append(None)

    # Check if all speeds are the same
    valid_speeds = [s for s in speeds if s is not None]
    if len(valid_speeds) >= 2:
        all_same = len(set(valid_speeds)) == 1
        same_str = "✅ YES" if all_same else f"❌ NO ({len(set(valid_speeds))} vals)"
    else:
        same_str = "—"

    print(f"{seq:>4} {code:>6} {is_halt:>5} {str(dist):>5}", end="")
    for s in speeds:
        if s is not None:
            print(f"  {s:>{col_width}.1f}", end="")
        else:
            print(f"  {'N/A':>{col_width}}", end="")
    print(f"  {same_str:>10}")


# ── STEP 2: Focus on specific station pairs ──
print("\n\n" + "=" * 80)
print("STEP 2: Detailed comparison for 3 station pairs")
print("=" * 80)

# Pick pairs: (seq3→seq4), (halt pair in Konkan), (last pair)
focus_pairs = [
    (3, 4, "Sandhurst Rd → Byculla (non-halt, urban)"),
    (8, 9, "Dadar → Thane (halt → halt, suburban)"),  # DR→TNA
    (15, 16, "Panvel → Roha (Konkan entry)"),
]

# Find actual halt-to-halt pairs from schedule
for pair_from_seq, pair_to_seq, label in focus_pairs:
    print(f"\n  ── {label} (seq {pair_from_seq} → {pair_to_seq}) ──")
    print(f"  {'date':>12} {'speed_api':>10} {'dist_km':>8} {'sched_dep':>22} {'next_arr':>22} {'time_min':>9} {'speed_calc':>11} {'match?':>8}")
    print(f"  {'─'*12} {'─'*10} {'─'*8} {'─'*22} {'─'*22} {'─'*9} {'─'*11} {'─'*8}")

    for d in DATES:
        if not date_data[d] or "route" not in date_data[d]:
            print(f"  {d:>12} — no data —")
            continue

        route = date_data[d]["route"]
        sta_from = next((s for s in route if s["sequence"] == pair_from_seq), None)
        sta_to = next((s for s in route if s["sequence"] == pair_to_seq), None)

        if not sta_from or not sta_to:
            print(f"  {d:>12} — station not found —")
            continue

        speed_api = sta_from.get("speedToNextStationKmph")
        dist_from = sta_from.get("distance", 0)
        dist_to = sta_to.get("distance", 0)
        dist_km = dist_to - dist_from

        # Get departure from sta_from and arrival at sta_to
        dep_str = sta_from.get("scheduledDeparture") or sta_from.get("actualDeparture")
        arr_str = sta_to.get("scheduledArrival") or sta_to.get("scheduledDeparture")

        time_min = None
        speed_calc = None
        if dep_str and arr_str:
            try:
                dep = datetime.fromisoformat(dep_str)
                arr = datetime.fromisoformat(arr_str)
                time_min = (arr - dep).total_seconds() / 60
                if time_min > 0 and dist_km > 0:
                    speed_calc = (dist_km / time_min) * 60  # km/h
            except (ValueError, TypeError):
                pass

        match = ""
        if speed_api is not None and speed_calc is not None:
            diff = abs(speed_api - speed_calc)
            if diff < 0.5:
                match = "✅ exact"
            elif diff < 2:
                match = "≈ close"
            else:
                match = f"❌ Δ={diff:.1f}"

        print(
            f"  {d:>12} "
            f"{speed_api if speed_api is not None else 'N/A':>10} "
            f"{dist_km:>8} "
            f"{(dep_str or 'N/A'):>22} "
            f"{(arr_str or 'N/A'):>22} "
            f"{time_min if time_min is not None else 'N/A':>9} "
            f"{f'{speed_calc:.1f}' if speed_calc is not None else 'N/A':>11} "
            f"{match:>8}"
        )


# ── STEP 3: Global check — do ANY values vary? ──
print("\n\n" + "=" * 80)
print("STEP 3: Global variance check across all stations")
print("=" * 80)

varying_count = 0
constant_count = 0
na_count = 0

for station in ref_route:
    seq = station["sequence"]
    speeds = []
    for d in DATES:
        if date_data[d] and "route" in date_data[d]:
            route = date_data[d]["route"]
            match = next((s for s in route if s["sequence"] == seq), None)
            if match and match.get("speedToNextStationKmph") is not None:
                speeds.append(match["speedToNextStationKmph"])
    valid = [s for s in speeds if s is not None]
    if len(valid) >= 2:
        if len(set(valid)) == 1:
            constant_count += 1
        else:
            varying_count += 1
            # Print the varying ones
            code = station.get("stationCode", "?")
            print(f"  VARIES: seq={seq} ({code}) → values: {valid}")
    else:
        na_count += 1

print(f"\n  Summary:")
print(f"    Stations with constant speed across dates:  {constant_count}")
print(f"    Stations with VARYING speed across dates:   {varying_count}")
print(f"    Stations with insufficient data:            {na_count}")

if varying_count == 0:
    print(f"\n  ✅ VERDICT: speedToNextStationKmph is SCHEDULE-DERIVED.")
    print(f"     Every station shows the exact same value across all 4 dates.")
    print(f"     It's computed from: distance / scheduled_time_between_stops.")
    print(f"     → Safe to use as a feature, but it's NOT real-time observed speed.")
    print(f"     → It won't reflect actual delays, TSRs, or weather slowdowns.")
else:
    print(f"\n  🔍 VERDICT: speedToNextStationKmph appears to be LIVE-OBSERVED")
    print(f"     (or at least partially dynamic) — {varying_count} stations vary across dates.")
    print(f"     → This is more valuable as a predictive feature since it reflects")
    print(f"     actual operating conditions, not just schedule math.")

print("\nDone.")
