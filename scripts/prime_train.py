"""
prime_train.py — fetch one train's route + live snapshot into .cache/ so the
ETA model can serve it.

The model is cache-first for a reason (free tier: 1,000 req/month), but the
live-fleet train is 12051 while every cached run is 22229, so /eta/12051 404s.
This script fetches exactly the two files the model needs and nothing else:

    .cache/{train}_route.json        geometry for curvature (needs 1 request)
    .cache/{train}_live.json         schedule: stations, halts, distances

    python3 scripts/prime_train.py 12051

Costs **2 upstream requests**, once. Already-primed files are left alone unless
--force is passed, so re-running is free.

Requires network egress to api.railradar.in. API keys are read from .env the
same way fetch_dates.py does and are never printed or echoed.

Paths resolve against the REPO ROOT, not this script's directory — .env,
.cache/ and railradar_client.py all live one level up from scripts/.
"""
import os, sys, json

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)          # scripts/ -> repo root

# Load ONLY environment variables from .env — never read key values ourselves.
# setdefault so a real exported env var always wins over the file.
env_path = os.path.join(ROOT, ".env")
if os.path.exists(env_path):
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

sys.path.insert(0, ROOT)              # railradar_client.py sits in the root
from railradar_client import RailRadarClient

args = [a for a in sys.argv[1:] if not a.startswith("-")]
FORCE = "--force" in sys.argv
TRAIN = args[0] if args else "12051"

if not TRAIN.isdigit():
    print(f"ERROR: train number must be digits, got {TRAIN!r}")
    sys.exit(2)

CACHE = os.path.join(ROOT, ".cache")
os.makedirs(CACHE, exist_ok=True)

live_out = os.path.join(CACHE, f"{TRAIN}_live.json")
route_out = os.path.join(CACHE, f"{TRAIN}_route.json")

if not FORCE and os.path.exists(live_out) and os.path.exists(route_out):
    print(f"{TRAIN} is already primed — nothing fetched.")
    print(f"  {live_out}")
    print(f"  {route_out}")
    print("Pass --force to refetch (costs 2 upstream requests).")
    sys.exit(0)

client = RailRadarClient()

# ── Live/schedule ────────────────────────────────────────────────────────────
# get_live_status already returns payload["data"], which is the exact shape
# load_schedule expects from {train}_live.json. include_coordinates is what
# gives each station lat/lng, without which snap_halts_to_vertices degrades to
# a global scale factor (VERIFIED #12/#13).
if FORCE or not os.path.exists(live_out):
    try:
        live = client.get_live_status(
            TRAIN,
            geometry=False,          # schedule comes from here; geometry from _route
            include_coordinates=True,
        )
    except Exception as e:
        print(f"ERROR: live status fetch failed: {e}")
        sys.exit(1)

    stations = live.get("route", [])
    if not stations:
        print("ERROR: no stations in live payload — refusing to write cache.")
        sys.exit(1)

    with open(live_out, "w") as f:
        json.dump(live, f)
else:
    live = json.load(open(live_out))
    stations = live.get("route", [])
    print(f"  (kept existing {os.path.basename(live_out)})")

# ── Route geometry ───────────────────────────────────────────────────────────
# get_route_geometry also returns payload["data"], carrying the extra `geojson`
# wrapper at top level (VERIFIED #1) — the same shape load_route_coords reads.
if FORCE or not os.path.exists(route_out):
    try:
        route = client.get_route_geometry(TRAIN)
    except Exception as e:
        print(f"ERROR: route geometry fetch failed: {e}")
        sys.exit(1)

    coords = route.get("geojson", {}).get("geometry", {}).get("coordinates", [])
    if not coords:
        print("ERROR: no coordinates in route payload — refusing to write cache.")
        sys.exit(1)

    with open(route_out, "w") as f:
        json.dump(route, f)
else:
    route = json.load(open(route_out))
    coords = route.get("geojson", {}).get("geometry", {}).get("coordinates", [])
    print(f"  (kept existing {os.path.basename(route_out)})")

# ── Report structure, never values (CLAUDE.md §8: print intermediate numbers) ─
halts = [s for s in stations if s.get("isHalt")]
with_latlng = sum(1 for s in stations if s.get("lat") is not None and s.get("lng") is not None)
print(f"Primed {TRAIN}:")
print(f"  {live_out}")
print(f"    {len(stations)} stations, {len(halts)} halts, {with_latlng} with lat/lng")
if halts:
    print(f"    chainage {halts[0].get('distance')} -> {halts[-1].get('distance')} km")
print(f"  {route_out}")
print(f"    {len(coords)} geometry vertices")
if with_latlng < len(stations):
    print("  WARNING: some stations lack lat/lng — halt anchoring will fall back")
    print("           to a global scale factor (VERIFIED #12). Check includeCoordinates.")
print()
print(f"Now restart the model (no --reload in launch.json) and GET /eta/{TRAIN}.")
