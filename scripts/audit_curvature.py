"""Roster-wide curvature coverage after the per-block wiring.

Prints intermediate numbers per CLAUDE.md §8: the coverage distribution, the
mixed-coverage cases, and a reconciliation that curvature is only summed over
blocks that have alignment.

    python3 scripts/audit_curvature.py [--limit N]
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import conflict  # noqa: E402  (roster source)
import corridor_geometry as cgeom  # noqa: E402
import eta_model  # noqa: E402


def roster():
    """The 206 conflict-relevant corridor trains, plus the cache demo trains.

    `_load_full_dataset()` is already filtered to `conflict_relevant` and keyed
    by train number, so its keys ARE the roster.
    """
    out = list(conflict._load_full_dataset().keys())
    import glob
    for p in glob.glob(os.path.join(eta_model.CACHE, "corridor", "*.json")):
        n = os.path.basename(p)[:-5]
        if n not in out:
            out.append(n)
    return sorted(set(out))


def main():
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])

    print("reference polylines in .cache/")
    for r in cgeom.audit():
        print(f"  {r['train']}  {r['vertices']:>5} vertices  "
              f"anchors {r['anchoredCodes']:>3} codes  "
              f"canonical km {r['canonicalRangeKm']}  "
              f"{'UNUSABLE: ' + str(r['unusable']) if r['unusable'] else ''}")
    print()

    trains = roster()
    if limit:
        trains = trains[:limit]
    print(f"auditing {len(trains)} trains\n")

    rows, failed = [], []
    for n in trains:
        try:
            r = eta_model.compute_eta(n, conflicts=False)
        except Exception as e:                                   # noqa: BLE001
            failed.append((n, f"{type(e).__name__}: {e}"))
            continue
        gc = r["geometry_coverage"]
        rows.append({
            "train": n,
            "basis": r["geometry_basis"],
            "avail": r["curvature_available"],
            "res": gc["blocks_resolved"], "tot": gc["blocks_total"],
            "covkm": gc["coverage_km"], "totkm": gc["total_km"],
            "frac": gc["coverage_fraction"],
            "refs": gc["reference_trains"],
            "reason": gc["unavailable_reason"],
            "curve_min": r["curvature_layer_contribution_min"],
            "resolvable_pct": (r["geometry_resolution"] or {}).get("resolvable_pct"),
        })

    full = [x for x in rows if x["frac"] >= 0.999]
    part = [x for x in rows if 0 < x["frac"] < 0.999]
    none = [x for x in rows if x["frac"] == 0]

    print("CURVATURE COVERAGE (northern reference only — south of MAO not primed)")
    print(f"  trains audited                : {len(rows)}  "
          f"({len(failed)} could not be modelled at all)")
    print(f"  curvature_available = True    : {sum(1 for x in rows if x['avail'])}"
          f"   (was 1 before this change)")
    print(f"  FULL coverage  (>=99.9% km)   : {len(full)}")
    print(f"  PARTIAL coverage              : {len(part)}")
    print(f"  ZERO coverage (labelled)      : {len(none)}")
    print()
    by_basis = {}
    for x in rows:
        by_basis[x["basis"]] = by_basis.get(x["basis"], 0) + 1
    print("  geometry_basis distribution:")
    for k, v in sorted(by_basis.items(), key=lambda kv: -kv[1]):
        print(f"    {str(k):28} {v}")
    print()
    tot_km = sum(x["totkm"] for x in rows)
    cov_km = sum(x["covkm"] for x in rows)
    print(f"  roster km with alignment      : {cov_km:,.0f} / {tot_km:,.0f} km "
          f"= {cov_km / tot_km * 100:.1f}%")
    print()

    print("  SILENT zeros (0 coverage, no reason given):",
          sum(1 for x in none if not x["reason"]))
    reasons = {}
    for x in none:
        reasons[x["reason"]] = reasons.get(x["reason"], 0) + 1
    for k, v in sorted(reasons.items(), key=lambda kv: -kv[1]):
        print(f"    {v:>4}  {k}")
    print()

    if part:
        print("  PARTIAL-coverage sample (the mixed case the per-block gate exists for):")
        for x in sorted(part, key=lambda x: -x["frac"])[:12]:
            print(f"    {x['train']}  blocks {x['res']:>2}/{x['tot']:<2}  "
                  f"{x['covkm']:>6.1f}/{x['totkm']:<6.1f} km = {x['frac'] * 100:5.1f}%  "
                  f"refs={x['refs']}  curve={x['curve_min']}")
        print()

    if failed:
        print("  trains that could not be modelled (schedule missing, not geometry):")
        for n, e in failed[:10]:
            print(f"    {n}  {e}")
        if len(failed) > 10:
            print(f"    ... and {len(failed) - 10} more")

    with open(os.path.join(eta_model.CACHE, "curvature_coverage_audit.json"), "w") as f:
        json.dump({"rows": rows, "failed": failed}, f, indent=1)
    print("\n  wrote .cache/curvature_coverage_audit.json")


if __name__ == "__main__":
    main()
