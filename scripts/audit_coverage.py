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

    for t in trains:
        try:
            r = C.find_conflicts(t, 30.0, service_date=SERVICE_DATE)
            conflict_ok += 1
            if not r["conflicts"]:
                zero_rows.append((t, r["trainTypeNormalised"],
                                  len([x for x in r["_meta"]["trainsConsidered"] if x["used"]]),
                                  len(r["_meta"]["trainsConsidered"])))
        except Exception as exc:                          # noqa: BLE001
            k = classify(exc)
            conflict_fail[k] += 1
            conflict_detail[k].append(t)

        try:
            res = E.compute_eta(t, conflicts=False)
            eta_ok += 1
            if res.get("curvature_available"):
                curv_ok += 1
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
    print(f"  answered but ZERO crossings: {len(zero_rows)}")
    for t, ty, used, total in zero_rows[:15]:
        print(f"            {t:<7} {ty:<14} used {used:>3}/{total}")
    if len(zero_rows) > 15:
        print(f"            ... and {len(zero_rows) - 15} more")

    print()
    print("=== ETA engine ===")
    print(f"  answered: {eta_ok}/{len(trains)}")
    print(f"  with curvature layer: {curv_ok}/{len(trains)}")
    for k, n in eta_fail.most_common():
        print(f"  FAIL {n:>4}  {k}")
        print(f"            e.g. {', '.join(eta_detail[k][:8])}")


if __name__ == "__main__":
    sys.exit(main())
