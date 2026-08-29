"""
fetch_dates.py — cache-first utility to ADD more historical run-dates.

Run this when you have network access to api.railradar.in. It computes valid
run-dates for the train (Mon/Wed/Fri for 22229), skips anything already cached,
fetches only what's missing, and then re-audits whether the new runs contain a
real delay signal.

    python3 fetch_dates.py            # default: 22229, 5 most recent missing runs
    python3 fetch_dates.py 22229 8    # train, how many missing dates to fetch
"""
import os, sys, json, glob
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))

with open(os.path.join(HERE, ".env")) as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

from railradar_client import RailRadarClient

TRAIN = sys.argv[1] if len(sys.argv) > 1 else "22229"
HOW_MANY = int(sys.argv[2]) if len(sys.argv) > 2 else 5
CACHE = os.path.join(HERE, ".cache")
os.makedirs(CACHE, exist_ok=True)
RUN_DAYS = {0, 2, 4}          # Mon, Wed, Fri (Python weekday(): Mon=0)
TODAY = date.today()
WEEKS_BACK = 6

# ── candidate run-dates, most recent completed first ──
candidates = []
d = TODAY - timedelta(days=1)
while d >= TODAY - timedelta(days=7 * WEEKS_BACK):
    if d.weekday() in RUN_DAYS:
        candidates.append(d.isoformat())
    d -= timedelta(days=1)

existing = {
    os.path.basename(p).replace(f"{TRAIN}_live_", "").replace(".json", "")
    for p in glob.glob(os.path.join(CACHE, f"{TRAIN}_live_20*.json"))
}
missing = [x for x in candidates if x not in existing]
to_fetch = missing[:HOW_MANY]

print(f"Train {TRAIN} — run-dates in last {WEEKS_BACK} weeks: {len(candidates)}")
print(f"  already cached : {len(existing)} → {', '.join(sorted(existing)) or '(none)'}")
print(f"  will fetch     : {len(to_fetch)} → {', '.join(to_fetch) or '(nothing missing)'}")

client = None
fetched = []
for dt_ in to_fetch:
    cache_file = os.path.join(CACHE, f"{TRAIN}_live_{dt_}.json")
    if os.path.exists(cache_file):
        print(f"  📦 {dt_}: cache hit, skipping")
        continue
    if client is None:
        client = RailRadarClient()
    print(f"  🌐 {dt_}: fetching...", end=" ", flush=True)
    try:
        data = client.get_live_status(TRAIN, date=dt_, geometry=False)
        with open(cache_file, "w") as f:
            json.dump(data, f)
        fetched.append(dt_)
        print("cached ✅")
    except Exception as e:
        print(f"❌ {type(e).__name__}: {e}")

# ── re-audit every cached dated run for a real delay signal ──
print("\n" + "=" * 92)
print("DELAY-SIGNAL AUDIT — every cached dated run")
print("=" * 92)
print(f"{'date':>12} {'status':>10} {'trackMode':>11} {'delayMin':>9} "
      f"{'nzDelayArr':>11} {'nzDelayDep':>11} {'act!=sched':>11}  VERDICT")
any_real = False
for path in sorted(glob.glob(os.path.join(CACHE, f"{TRAIN}_live_20*.json"))):
    dt_ = os.path.basename(path).replace(f"{TRAIN}_live_", "").replace(".json", "")
    with open(path) as f:
        j = json.load(f)
    rt = j.get("route", [])
    nz_arr = sum(1 for s in rt if s.get("delayArrival"))
    nz_dep = sum(1 for s in rt if s.get("delayDeparture"))
    mism = sum(1 for s in rt for a, b in [("scheduledArrival", "actualArrival"),
               ("scheduledDeparture", "actualDeparture")]
               if s.get(a) and s.get(b) and s[a] != s[b])
    real = bool(nz_arr or nz_dep or mism)
    any_real = any_real or real
    verdict = "REAL DELAY ✅" if real else "(zero echo)"
    print(f"{dt_:>12} {str(j.get('status')):>10} {str(j.get('trackingMode')):>11} "
          f"{str(j.get('delayMinutes')):>9} {nz_arr:>11} {nz_dep:>11} {mism:>11}  {verdict}")

print()
if any_real:
    print("✅ At least one run has a real delay signal — the historical-delay layer of the")
    print("   model will now contribute non-zero buffer time. Re-run: python3 report_eta.py")
else:
    print("⚠️  No run exposes real actuals. Every completed run echoes the timetable")
    print("   (trackingMode='none', actualArrival == scheduledArrival, delayArrival null/0).")
    print("   The historical-delay layer stays at 0.0 min — reported honestly, not guessed.")
if fetched:
    print(f"\nNewly cached this run: {', '.join(fetched)}")
