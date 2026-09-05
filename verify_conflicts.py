"""
verify_conflicts.py — invariant checks for the crossing/overtake model.

Offline, no API calls.  Re-run after any change to conflict.py.
Every check is a property that must hold for ANY train and ANY delay, so a
regression shows up as a FAIL rather than as a plausible-looking wrong number.

    python3 verify_conflicts.py
"""
import sys, itertools

import conflict

TRAINS = ["12051", "22229", "10103", "12052", "10104", "16346", "12617", "01132"]
DELAYS = [0, 15, 45, 90, 150, 240]

fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)
    return cond


print("=== Invariants over every (train, delay) pair ===")
rows = 0
for train in TRAINS:
    for d in DELAYS:
        r = conflict.find_conflicts(train, d)
        lo, hi = r["_meta"]["singleLineSectionKm"]
        tag = f"{train}+{d:>3}"
        seen = set()
        for c in r["conflicts"]:
            rows += 1
            # 1. A meet can only be reported inside the single-line section.
            #    CSMT->Roha is double line and needs no hold at all.
            check(lo - 0.05 <= c["meetKm"] <= hi + 0.05,
                  f"{tag}: meet km {c['meetKm']} outside single-line [{lo},{hi}]")
            # 2. Holds are durations: never negative.
            check(c["ourHoldMin"] >= 0 and c["theirHoldMin"] >= 0,
                  f"{tag}: negative hold {c['ourHoldMin']}/{c['theirHoldMin']}")
            # 3. Exactly one train is held per meet — never both.
            if c["whoIsHeld"] == "us":
                check(c["theirHoldMin"] == 0, f"{tag}: both trains held")
                check(c["ourHoldMin"] >= conflict.REACCEL_MIN,
                      f"{tag}: our hold {c['ourHoldMin']} below REACCEL_MIN")
            else:
                check(c["ourHoldMin"] == 0, f"{tag}: both trains held")
                check(c["theirHoldMin"] >= conflict.REACCEL_MIN,
                      f"{tag}: their hold {c['theirHoldMin']} below REACCEL_MIN")
            # 4. The same meet must not be reported twice.  A gap of exactly 0
            #    at a station is detectable from either neighbouring interval;
            #    the half-open sign test is what prevents the double count.
            key = (c["otherTrain"], c["instanceOffsetDays"],
                   c["betweenFrom"], c["betweenTo"])
            check(key not in seen, f"{tag}: duplicate meet {key}")
            seen.add(key)
            # 5. An overtake names the passing train; a head-on meet does not.
            if c["kind"] == "overtake":
                check(c["overtakingTrain"] in (train, c["otherTrain"]),
                      f"{tag}: overtake without a valid overtaker")
            else:
                check(c["overtakingTrain"] is None,
                      f"{tag}: head-on meet claims an overtaker")
            # 6. Coordinates are either usable or explicitly flagged unusable.
            if c["meetCoordsBasis"] == "interpolated":
                check(12 < c["meetLat"] < 20 and 72 < c["meetLng"] < 76,
                      f"{tag}: meet coords {c['meetLat']},{c['meetLng']} off-corridor")
            else:
                check(c["meetLat"] is None and c["meetLng"] is None,
                      f"{tag}: coords flagged unavailable but present")
            # 9. The delay-shift block is self-consistent: a meet either has an
            #    on-time counterpart (so both scheduledMeetKm and shiftKm exist
            #    and reconcile) or is delay-created (so both are null).  A shift
            #    without a baseline km would be an unfalsifiable number.
            if c["existsOnTime"]:
                check(c["scheduledMeetKm"] is not None and c["shiftKm"] is not None,
                      f"{tag}: existsOnTime but shift fields are null")
                check(abs((c["meetKm"] - c["scheduledMeetKm"]) - c["shiftKm"]) < 0.11,
                      f"{tag}: shiftKm {c['shiftKm']} != {c['meetKm']} - "
                      f"{c['scheduledMeetKm']}")
            else:
                check(c["scheduledMeetKm"] is None and c["shiftKm"] is None,
                      f"{tag}: delay-created meet carries a baseline km")
                check(d != 0, f"{tag}: delay-created meet at zero delay")
            # 10. At zero delay nothing can have moved, by definition.
            if d == 0:
                check(c["shiftKm"] == 0.0 and c["existsOnTime"],
                      f"{tag}: nonzero shift at zero delay")
        # 7. The headline total must equal the sum of the rows behind it.
        tot = round(sum(c["ourHoldMin"] for c in r["conflicts"]), 1)
        check(abs(tot - r["totalHoldMin"]) < 0.05,
              f"{tag}: total {r['totalHoldMin']} != row sum {tot}")
        # 8. Output ordering is by chainage, so the UI never has to re-sort.
        kms = [c["meetKm"] for c in r["conflicts"]]
        check(kms == sorted(kms), f"{tag}: conflicts not sorted by km")
        check(r["heldCount"] + r["precedenceCount"] == len(r["conflicts"]),
              f"{tag}: held+precedence != conflict count")
print(f"  {len(TRAINS)} trains x {len(DELAYS)} delays, {rows} conflict rows checked")

print()
print("=== Determinism ===")
a = conflict.find_conflicts("12051", 45)
b = conflict.find_conflicts("12051", 45)
# _meta carries a build timestamp only in the corridor files, not here, so the
# whole payload must compare equal.
check(a == b, "find_conflicts is not deterministic")
print("  identical on repeat call: ", a == b)

print()
print("=== Type normalisation (the C9 fix) ===")
CASES = [
    ("MAIL/EXPRESS", "Mail/Express", 5),
    ("MAIL EXPRESS", "Mail/Express", 5),
    ("Mail/Express", "Mail/Express", 5),
    ("SUPERFAST", "Superfast", 4),
    ("Superfast Express", "Superfast", 4),
    ("JAN SHATABDI", "Jan Shatabdi", 3),
    ("Shatabdi Express", "Shatabdi", 2),
    ("Vande Bharat Express", "Vande Bharat", 1),
    (None, "Unknown", 6),
]
for raw, want_label, want_rank in CASES:
    label, rank = conflict.normalise_type(raw)
    ok = (label, rank) == (want_label, want_rank)
    check(ok, f"normalise_type({raw!r}) -> {(label, rank)}, want {(want_label, want_rank)}")
    print(f"  {'ok ' if ok else 'FAIL'} {str(raw):<22} -> {label:<14} rank {rank}")
# 'JAN SHATABDI' contains 'SHATABDI'; if rule order ever regresses, Jan Shatabdi
# silently gains Shatabdi's precedence and starts winning crossings it should lose.
check(conflict.normalise_type("JAN SHATABDI")[1]
      > conflict.normalise_type("SHATABDI")[1],
      "Jan Shatabdi must rank BELOW Shatabdi (rule ordering regressed)")

print()
print("=== Delay monotonicity: more delay moves meets earlier along the route ===")
prev = None
for d in [0, 15, 30, 45, 60]:
    r = conflict.find_conflicts("12051", d)
    opp = [c for c in r["conflicts"] if c["kind"] == "opposing"
           and c["otherTrain"] == "12052"]
    if not opp:
        continue
    km = opp[0]["meetKm"]
    if prev is not None:
        check(km <= prev + 0.05,
              f"12051 +{d}: meet with 12052 moved forward to {km} from {prev}")
    print(f"  +{d:>3} min -> meet with 12052 at km {km:>6.1f} "
          f"({opp[0]['betweenFrom']}-{opp[0]['betweenTo']})")
    prev = km

print()
print("=== Reciprocity: a head-on meet must appear from BOTH trains' views ===")
# The pair is symmetric, so 12051-vs-12052 must be found when computed from
# either side, at the mirrored chainage (downKm = 582.3 - upKm).
ours = [c for c in conflict.find_conflicts("12051", 0)["conflicts"]
        if c["otherTrain"] == "12052"]
theirs = [c for c in conflict.find_conflicts("12052", 0)["conflicts"]
          if c["otherTrain"] == "12051"]
check(len(ours) == 1 and len(theirs) == 1,
      f"expected 1 meet from each side, got {len(ours)}/{len(theirs)}")
if ours and theirs:
    mirrored = 582.3 - theirs[0]["meetKm"]
    print(f"  from 12051: km {ours[0]['meetKm']:.1f}   "
          f"from 12052: km {theirs[0]['meetKm']:.1f} "
          f"(mirrors to {mirrored:.1f})")
    check(abs(ours[0]["meetKm"] - mirrored) < 2.0,
          f"meet km disagree across views: {ours[0]['meetKm']} vs {mirrored:.1f}")
    # Both views must agree on WHICH train is held — 12051 (Shatabdi, rank 2)
    # outranks 12052 (Jan Shatabdi, rank 3), so 12052 is held either way.
    check(ours[0]["whoIsHeld"] == "them" and theirs[0]["whoIsHeld"] == "us",
          f"views disagree on who is held: {ours[0]['whoIsHeld']}/{theirs[0]['whoIsHeld']}")
    print(f"  who is held — from 12051: {ours[0]['whoIsHeld']}, "
          f"from 12052: {theirs[0]['whoIsHeld']}  (both mean 12052 waits)")

print()
print("=== Overtakes are delay-conditional (VERIFIED C10) ===")
for train in ["12051", "22229"]:
    base = [c for c in conflict.find_conflicts(train, 0)["conflicts"]
            if c["kind"] == "overtake"]
    check(not base, f"{train} shows an overtake at zero delay; C10 says none exist "
                    f"on the scheduled timetable")
    print(f"  {train} at +0 min: {len(base)} overtakes (expected 0)")
found = [c for c in conflict.find_conflicts("22229", 150)["conflicts"]
         if c["kind"] == "overtake" and c["otherTrain"] == "10103"]
check(bool(found), "22229 +150 should overtake 10103 (C10)")
if found:
    print(f"  22229 at +150 min: overtakes 10103 at km {found[0]['meetKm']} "
          f"({found[0]['betweenFrom']}-{found[0]['betweenTo']})")
    # C10's consequence for the shift block: an overtake has no on-time
    # counterpart to have moved from, so it must report as delay-CREATED rather
    # than as a meet that shifted.  Conflating the two would let the UI claim a
    # planned crossing relocated when in fact none was ever planned.
    check(found[0]["existsOnTime"] is False,
          "overtake must be flagged delay-created, not shifted")
    print(f"  existsOnTime = {found[0]['existsOnTime']} "
          f"(delay-created, no scheduled counterpart)")

print()
print("=== Delay shift is monotonic and reconciles (C6) ===")
for d in [15, 45, 90]:
    r = conflict.find_conflicts("12051", d)
    moved = [c for c in r["conflicts"] if c["existsOnTime"]]
    created = [c for c in r["conflicts"] if not c["existsOnTime"]]
    # More delay can only push a head-on meet EARLIER along our own axis: the
    # other train keeps coming while we fall behind.
    check(all(c["shiftKm"] <= 0.05 for c in moved),
          f"12051 +{d}: a meet moved later along the route")
    shifts = [c["shiftKm"] for c in moved]
    print(f"  +{d:>3} min: {len(moved)} meets moved "
          f"({min(shifts):.1f} to {max(shifts):.1f} km), {len(created)} delay-created")

print()
print("=== Honesty flags present in every payload ===")
m = conflict.find_conflicts("12051", 0)["_meta"]
for key, want in [("loopDataIsOfficial", False),
                  ("priorityIsOfficial", False),
                  ("otherTrainsAreScheduled", True),
                  ("decisionSupportOnly", True)]:
    check(m.get(key) is want, f"_meta.{key} is {m.get(key)!r}, expected {want!r}")
    print(f"  {key} = {m.get(key)}")
check(m.get("loopBasis") == "assumed-all-stations", "loopBasis changed")
check(m.get("reaccelMin") == conflict.REACCEL_MIN, "reaccelMin not surfaced")

print()
if fails:
    print(f"FAILED ({len(fails)}):")
    for f in fails:
        print(f"  - {f}")
    sys.exit(1)
print("ALL CHECKS PASSED")
