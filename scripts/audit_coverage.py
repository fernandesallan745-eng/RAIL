"""Diagnostic sweep: which corridor trains do the conflict and ETA engines answer for?

Offline, cache-only, no API calls.  Classifies every failure by cause so the fix
targets the real blocker instead of the first traceback.
"""
import collections
import datetime
import json
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import conflict as C          # noqa: E402
import eta_model as E         # noqa: E402

SERVICE_DATE = datetime.date(2026, 9, 11)


def classify(exc):
    name = type(exc).__name__
    msg = str(exc)
    if isinstance(exc, FileNotFoundError):
        if "_route.json" in msg:
            return "no route geometry"
        if "corridor" in msg or "full dataset" in msg:
            return "not in either cache"
        return "missing file: " + os.path.basename(msg.split()[-1])
    return f"{name}: {msg[:70]}"


def main():
    trains = C.list_corridor_trains()
    print(f"trains known to the conflict model: {len(trains)}")

    conflict_fail = collections.Counter()
    conflict_detail = collections.defaultdict(list)
    eta_fail = collections.Counter()
    eta_detail = collections.defaultdict(list)
    conflict_ok = eta_ok = 0
    curv_ok = 0
    zero_rows = []

    # The distributions that say WHY a train answers the way it does.  A raw
    # "answered 210/210" hides the difference between a train with 50 crossings
    # and one that correctly reports it cannot have any — which is the whole
    # point of the explicit-unavailable-reason work.
    unavailable = collections.Counter()
    eligible = collections.Counter()
    confidence = collections.Counter()
    coords_basis = collections.Counter()
    section_basis = collections.Counter()
    geom_basis = collections.Counter()
    curv_seg = collections.Counter()
    roster_km = geom_km = 0.0

    for t in trains:
        try:
            r = C.find_conflicts(t, 30.0, service_date=SERVICE_DATE)
            conflict_ok += 1
            m = r["_meta"]
            eligible[bool(m.get("corridorEligible"))] += 1
            section_basis[m.get("singleLineBasis")] += 1
            if not r["conflicts"]:
                zero_rows.append((t, r["trainTypeNormalised"],
                                  len([x for x in m["trainsConsidered"] if x["used"]]),
                                  len(m["trainsConsidered"]),
                                  m.get("crossingsUnavailableReason")
                                  or m.get("corridorIneligibleReason")))
            unavailable[m.get("crossingsUnavailableReason")
                        or m.get("corridorIneligibleReason")] += 1
            for c in r["conflicts"]:
                confidence[c.get("locationConfidence")] += 1
                coords_basis[c.get("meetCoordsBasis")] += 1
        except Exception as exc:                          # noqa: BLE001
            k = classify(exc)
            conflict_fail[k] += 1
            conflict_detail[k].append(t)

        try:
            res = E.compute_eta(t, conflicts=False)
            eta_ok += 1
            geom_basis[res.get("geometry_basis")] += 1
            if res.get("curvature_available"):
                curv_ok += 1
            # Curvature is resolved PER BLOCK, so a train is not simply
            # covered or not: it can hold the shared polyline for its northern
            # blocks and nothing south of MAO.  Measure the km, not the trains.
            for s in res.get("segments") or []:
                d = s.get("distance_km") or 0.0
                roster_km += d
                if s.get("vertex_curve_running_min") is not None:
                    geom_km += d
                    curv_seg["with geometry"] += 1
                else:
                    curv_seg["no geometry"] += 1
        except Exception as exc:                          # noqa: BLE001
            k = classify(exc)
            eta_fail[k] += 1
            eta_detail[k].append(t)

    print()
    print("=== conflict engine ===")
    print(f"  answered: {conflict_ok}/{len(trains)}")
    for k, n in conflict_fail.most_common():
        print(f"  FAIL {n:>4}  {k}")
        print(f"            e.g. {', '.join(conflict_detail[k][:8])}")
    print(f"  corridor-eligible: {eligible[True]} / not eligible: {eligible[False]}")
    print(f"  answered but ZERO crossings: {len(zero_rows)}")
    silent = [row for row in zero_rows if not row[4]]
    for t, ty, used, total, why in zero_rows[:15]:
        print(f"            {t:<7} {ty:<14} used {used:>3}/{total}  "
              f"{why or '*** SILENT ZERO ***'}")
    if len(zero_rows) > 15:
        print(f"            ... and {len(zero_rows) - 15} more")
    # VERIFIED #9: a zero-valued layer hides its own bugs.  A train with no
    # crossings must say WHY, or it is indistinguishable from a broken one.
    print(f"  zero-crossing trains with NO stated reason: {len(silent)} "
          f"{'(must be 0)' if silent else '(good)'}")
    print("  unavailable reasons:")
    for k, n in unavailable.most_common():
        print(f"      {n:>4}  {k or '(has crossings / no reason needed)'}")
    print("  single-line section basis:")
    for k, n in section_basis.most_common():
        print(f"      {n:>4}  {k}")
    print("  meet location confidence:")
    for k, n in confidence.most_common():
        print(f"      {n:>4}  {k}")
    print("  meet coordinate basis:")
    for k, n in coords_basis.most_common():
        print(f"      {n:>4}  {k}")

    print()
    print("=== ETA engine ===")
    print(f"  answered: {eta_ok}/{len(trains)}")
    print(f"  with curvature layer: {curv_ok}/{len(trains)}")
    print("  geometry basis:")
    for k, n in geom_basis.most_common():
        print(f"      {n:>4}  {k}")
    if roster_km:
        print(f"  curvature coverage by DISTANCE: {geom_km:,.0f} of "
              f"{roster_km:,.0f} roster km = {100 * geom_km / roster_km:.1f}%")
        print(f"      blocks with geometry {curv_seg['with geometry']}, "
              f"without {curv_seg['no geometry']}")
    for k, n in eta_fail.most_common():
        print(f"  FAIL {n:>4}  {k}")
        print(f"            e.g. {', '.join(eta_detail[k][:8])}")

    print()
    print("=== corridor-wide sweep ===")
    sweep = C.corridor_conflicts(SERVICE_DATE)
    ms = sweep["meets"]
    drawable = sum(1 for m in ms if m.get("lat") is not None)
    kinds = collections.Counter(m["kind"] for m in ms)
    print(f"  service date {sweep['serviceDate']}: {len(ms)} unique meets "
          f"over {sweep['trainsSwept']} trains "
          f"({sweep['trainsWithCrossings']} with crossings, "
          f"{sweep['trainsUnavailable']} labelled unavailable)")
    print(f"  kinds: {dict(kinds)}")
    print(f"  drawable on the map: {drawable}/{len(ms)} = "
          f"{100 * drawable / len(ms):.1f}%")
    print(f"  duplicate views merged: {sweep.get('duplicateViewsMerged')} exact + "
          f"{sweep.get('duplicateViewsMergedByTolerance')} by tolerance")


if __name__ == "__main__":
    sys.exit(main())
