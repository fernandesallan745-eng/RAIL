"""
build_corridor.py — normalise cached train schedules into the compact form the
conflict model needs.  **Offline: no network, no API calls.**

Input : .cache/train_{number}_live_fallback.json   (written by the Node gateway)
Output: .cache/corridor/{number}.json

Why this exists
---------------
Crossing prediction needs *other* trains' timetables, not their live positions.
Timetables are static, so they can be normalised once and reused forever — which
is what keeps the whole feature at **zero upstream requests**.  Calling
get_live_status() per candidate train (the obvious approach) would trip
RailRadar's 10 req/min ceiling and burn ~1.5% of a monthly key per evaluation.

The one transformation that matters
-----------------------------------
Cached runs are from four different service dates, so absolute ISO timestamps
are not comparable between trains.  Every time is converted to **day-normalised
minutes**:

    t = (journeyDay - 1) * 1440 + (hh * 60 + mm)

`arrivalDay` / `departureDay` are authoritative for the day index — NOT the date
inside the ISO string, which is the date that particular cached run happened to
execute on.  Comparing raw ISO strings finds no crossings at all.

    python3 scripts/build_corridor.py --dry-run    # audit, writes nothing
    python3 scripts/build_corridor.py              # write .cache/corridor/
"""
import os, sys, json, glob, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)              # scripts/ -> repo root
CACHE = os.path.join(ROOT, ".cache")
OUT_DIR = os.path.join(CACHE, "corridor")

DRY_RUN = "--dry-run" in sys.argv

# `fleet_fallback.json` matches the same glob but is a fleet *array*, not a
# train.  Skipped by name rather than by shape: a shape sniff would silently
# start including it the day its wrapper changes.
SKIP_BASENAMES = {"fleet_fallback.json"}


def day_minutes(iso, day):
    """ISO timestamp + journey-day index -> day-normalised minutes.

    Returns None when either input is missing.  `scheduledArrival` is absent on
    the origin row of every train, which is expected, not a defect.
    """
    if not iso or day is None:
        return None
    try:
        # fromisoformat handles the +05:30 offset.  Only the clock time is used;
        # the date part is discarded in favour of the journey-day index.
        t = datetime.datetime.fromisoformat(iso)
    except (ValueError, TypeError):
        return None
    return (int(day) - 1) * 1440 + t.hour * 60 + t.minute


def normalise(path):
    """One fallback file -> one corridor record, or None if unusable."""
    with open(path) as f:
        payload = json.load(f)

    info = payload.get("train") or {}
    number = info.get("number") or payload.get("trainNumber")
    if not number:
        return None, "no train number"

    raw = payload.get("route") or []
    if not raw:
        return None, "no route"

    stations = []
    for s in raw:
        code = s.get("stationCode")
        km = s.get("distance")
        if not code or km is None:
            continue
        stations.append({
            "code": code,
            "name": s.get("stationName"),
            "km": float(km),
            "arrMin": day_minutes(s.get("scheduledArrival"), s.get("arrivalDay")),
            "depMin": day_minutes(s.get("scheduledDeparture"), s.get("departureDay")),
            "isHalt": bool(s.get("isHalt")),
            # Carried so a predicted meet point can be interpolated into a real
            # lat/lng for the map without the client doing any geometry.
            "lat": s.get("lat"),
            "lng": s.get("lng"),
        })

    if len(stations) < 2:
        return None, "fewer than 2 usable stations"

    record = {
        "number": str(number),
        "name": info.get("name") or payload.get("trainName"),
        "type": info.get("type"),
        "category": info.get("category"),
        "avgSpeed": info.get("avgSpeed"),
        "source": info.get("source"),
        "destination": info.get("destination"),
        "stations": stations,
        "_meta": {
            "builtFrom": os.path.basename(path),
            "builtAt": datetime.datetime.now().isoformat(timespec="seconds"),
            "timeBasis": "day-normalised minutes: (journeyDay-1)*1440 + hh*60+mm",
            "timesAreScheduled": True,
            "note": (
                "Scheduled times only — this file carries NO live data and needs "
                "no refresh to stay correct.  The cached run's own service date "
                "is deliberately discarded (see day_minutes)."
            ),
        },
    }
    return record, None


def main():
    paths = sorted(glob.glob(os.path.join(CACHE, "train_*_live_fallback.json")))
    if not paths:
        print(f"ERROR: no train_*_live_fallback.json under {CACHE}")
        return 1

    print(f"Scanning {CACHE}")
    print(f"  {len(paths)} file(s) match train_*_live_fallback.json")

    built, skipped, failed = [], [], []
    for p in paths:
        base = os.path.basename(p)
        if base in SKIP_BASENAMES:
            skipped.append((base, "fleet array, not a train"))
            continue
        try:
            record, err = normalise(p)
        except Exception as e:                      # noqa: BLE001 — report, don't abort
            failed.append((base, repr(e)))
            continue
        if record is None:
            failed.append((base, err))
            continue
        built.append(record)

    for base, why in skipped:
        print(f"  skip  {base:<40} {why}")
    for base, why in failed:
        print(f"  FAIL  {base:<40} {why}")

    if not built:
        print("ERROR: nothing built.")
        return 1

    if not DRY_RUN:
        os.makedirs(OUT_DIR, exist_ok=True)

    # Per-train audit.  CLAUDE.md §8: print intermediate numbers, not just totals.
    print()
    print(f"{'train':<8}{'type':<22}{'stns':>5}{'halts':>6}{'km span':>16}"
          f"{'time span (min)':>18}  name")
    for r in sorted(built, key=lambda x: x["number"]):
        st = r["stations"]
        halts = sum(1 for s in st if s["isHalt"])
        kms = [s["km"] for s in st]
        times = [s["arrMin"] for s in st if s["arrMin"] is not None]
        tspan = f"{min(times)}..{max(times)}" if times else "—"
        print(f"{r['number']:<8}{(r['type'] or '?')[:21]:<22}{len(st):>5}{halts:>6}"
              f"{min(kms):>7.1f}..{max(kms):<7.1f}{tspan:>18}  {(r['name'] or '')[:38]}")
        if not DRY_RUN:
            with open(os.path.join(OUT_DIR, f"{r['number']}.json"), "w") as f:
                json.dump(r, f, indent=1)

    # Missing-time audit: a station with neither arrival nor departure is invisible
    # to the crossing walk, so its count has to be visible here.
    print()
    holes = 0
    for r in built:
        n = sum(1 for s in r["stations"] if s["arrMin"] is None and s["depMin"] is None)
        if n:
            # The origin legitimately has no arrival, but it always has a departure,
            # so it never lands in this count.
            print(f"  {r['number']}: {n} station(s) with no usable time")
            holes += n
    print(f"  stations with no usable time: {holes}")

    print()
    print(f"{len(built)} train(s) normalised"
          + ("  [--dry-run: nothing written]" if DRY_RUN else f" -> {OUT_DIR}"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
