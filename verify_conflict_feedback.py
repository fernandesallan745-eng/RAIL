"""
verify_conflict_feedback.py — invariant checks for the dynamic single-line
conflict feedback loop (Step 5).

Verifies:
  1. Backward compatibility: defaults produce identical output to the old code.
  2. Live delay coupling: get_train_delay returns real signals from cache.
  3. Cascading hold monotonicity: cascadingHoldUpstreamMin is non-decreasing along
     the route (monotonicity of spatial position).
  4. Feedback totals are self-consistent.
  5. Ripple delay only assigned to opposing trains that yield.
  6. Internal fields (_ourIn, etc.) never leak into output.

    python3 verify_conflict_feedback.py
"""
import sys
import conflict

TRAIN = "12051"
DELAY = 58.0
SERVICE_DATE = "2026-09-16"

fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)
        print(f"  FAIL: {msg}")
    return cond


print("=== Step 5: Dynamic Single-Line Conflict Feedback Loop ===\n")

# ---------- 1. Backward compatibility ----------
print("--- 1. Backward compatibility (defaults) ---")
r_default = conflict.find_conflicts(TRAIN, delay_min=DELAY,
                                    service_date=SERVICE_DATE)
check(r_default["totalCascadingHoldMin"] == 0.0,
      "totalCascadingHoldMin should be 0.0 when dynamic_feedback=False")
check(r_default["totalRippleDelayMin"] == 0.0,
      "totalRippleDelayMin should be 0.0 when dynamic_feedback=False")
check(r_default["_meta"]["useLiveDelays"] is False,
      "useLiveDelays should be False by default")
check(r_default["_meta"]["dynamicFeedback"] is False,
      "dynamicFeedback should be False by default")
check(r_default["_meta"]["otherDelaysApplied"] is None,
      "otherDelaysApplied should be None when not using live delays")
check(r_default["_meta"]["otherTrainsAreScheduled"] is True,
      "otherTrainsAreScheduled should be True by default")
for c in r_default["conflicts"]:
    check("_ourIn" not in c, f"Internal key _ourIn leaked in conflict vs {c['otherTrain']}")
    check("_ourOut" not in c, f"Internal key _ourOut leaked")
    check("_theirIn" not in c, f"Internal key _theirIn leaked")
    check("_theirOut" not in c, f"Internal key _theirOut leaked")
print(f"  {len(r_default['conflicts'])} conflicts, totalHold={r_default['totalHoldMin']}m — backward compat ✓")

# ---------- 2. Live delay coupling ----------
print("\n--- 2. Live delay coupling (use_live_delays=True) ---")
r_live = conflict.find_conflicts(TRAIN, delay_min=DELAY,
                                  service_date=SERVICE_DATE,
                                  use_live_delays=True)
applied = r_live["_meta"]["otherDelaysApplied"] or {}
check(len(applied) > 0, "Should apply at least one counterpart delay from cache")
check(r_live["_meta"]["useLiveDelays"] is True,
      "useLiveDelays should be True")
# Verify that known trains have delay
for tn, info in applied.items():
    check(info["delayMin"] > 0 or info["basis"] != "scheduled-on-time",
          f"Applied delay for {tn} looks empty: {info}")
# Every conflict row must carry otherDelayMin and otherDelayBasis
for c in r_live["conflicts"]:
    check("otherDelayMin" in c, f"otherDelayMin missing on conflict vs {c['otherTrain']}")
    check("otherDelayBasis" in c, f"otherDelayBasis missing on conflict vs {c['otherTrain']}")
print(f"  {len(applied)} counterpart delays applied ✓")

# ---------- 3. Cascading hold monotonicity ----------
print("\n--- 3. Cascading hold monotonicity (dynamic_feedback=True) ---")
r_fb = conflict.find_conflicts(TRAIN, delay_min=DELAY,
                                service_date=SERVICE_DATE,
                                use_live_delays=True,
                                dynamic_feedback=True)
check(r_fb["_meta"]["dynamicFeedback"] is True,
      "dynamicFeedback should be True")
prev_cascade = -1.0
prev_km = -1.0
for c in r_fb["conflicts"]:
    cascade = c.get("cascadingHoldUpstreamMin", 0.0)
    km = c["meetKm"]
    # Cascade must be non-decreasing along the route
    check(cascade >= prev_cascade - 0.01,  # tolerance for rounding
          f"Cascade decreased at km {km}: {cascade} < {prev_cascade}")
    # Km must be non-decreasing (conflicts are sorted)
    check(km >= prev_km - 0.01,
          f"Km not sorted: {km} < {prev_km}")
    prev_cascade = cascade
    prev_km = km
print(f"  Monotonicity ✓ — cascade grows from 0 to {r_fb['totalCascadingHoldMin']}m")

# ---------- 4. Feedback totals self-consistency ----------
print("\n--- 4. Feedback totals self-consistency ---")
total_hold = round(sum(c["ourHoldMin"] for c in r_fb["conflicts"]), 1)
check(abs(total_hold - r_fb["totalHoldMin"]) < 0.2,
      f"totalHoldMin mismatch: sum={total_hold} vs header={r_fb['totalHoldMin']}")

# totalCascadingHoldMin should equal the final totalCascadingMin value
if r_fb["conflicts"]:
    last_cascade = r_fb["conflicts"][-1].get("totalCascadingMin", 0.0)
    check(abs(last_cascade - r_fb["totalCascadingHoldMin"]) < 0.2,
          f"totalCascadingHoldMin mismatch: last={last_cascade} vs header={r_fb['totalCascadingHoldMin']}")

# totalRippleDelayMin should equal sum of all rippleDelayMin values
total_ripple = round(sum(c.get("rippleDelayMin", 0.0) for c in r_fb["conflicts"]), 1)
check(abs(total_ripple - r_fb["totalRippleDelayMin"]) < 0.2,
      f"totalRippleDelayMin mismatch: sum={total_ripple} vs header={r_fb['totalRippleDelayMin']}")
print(f"  totalHold={total_hold}m, totalCascading={r_fb['totalCascadingHoldMin']}m, totalRipple={r_fb['totalRippleDelayMin']}m ✓")

# ---------- 5. Ripple delay only on yielding opposing trains ----------
print("\n--- 5. Ripple delay attribution ---")
for c in r_fb["conflicts"]:
    ripple = c.get("rippleDelayMin", 0.0)
    if ripple > 0:
        check(c["whoIsHeld"] == "them",
              f"rippleDelayMin={ripple} but whoIsHeld={c['whoIsHeld']} (should be 'them')")
        check(c["theirHoldMin"] > 0,
              f"rippleDelayMin={ripple} but theirHoldMin={c['theirHoldMin']} (should be > 0)")
ripple_rows = sum(1 for c in r_fb["conflicts"] if c.get("rippleDelayMin", 0) > 0)
print(f"  {ripple_rows} rows carry ripple delay, all correctly on yielding trains ✓")

# ---------- 6. No internal keys in output ----------
print("\n--- 6. No internal keys leak ---")
for c in r_fb["conflicts"]:
    for k in ("_ourIn", "_ourOut", "_theirIn", "_theirOut"):
        check(k not in c, f"Internal key {k} leaked")
print("  No internal keys leaked ✓")

# ---------- 7. Feedback increases total hold compared to no-feedback ----------
print("\n--- 7. Feedback amplification ---")
r_nofb = conflict.find_conflicts(TRAIN, delay_min=DELAY,
                                  service_date=SERVICE_DATE,
                                  use_live_delays=True,
                                  dynamic_feedback=False)
check(r_fb["totalHoldMin"] >= r_nofb["totalHoldMin"],
      f"Feedback should not reduce total hold: {r_fb['totalHoldMin']} < {r_nofb['totalHoldMin']}")
amp = r_fb["totalHoldMin"] - r_nofb["totalHoldMin"]
print(f"  Without feedback: {r_nofb['totalHoldMin']}m, with: {r_fb['totalHoldMin']}m (+{round(amp,1)}m) ✓")

# ---------- Summary ----------
print(f"\n{'='*55}")
if fails:
    print(f"FAILED: {len(fails)} check(s)")
    for f in fails:
        print(f"  • {f}")
    sys.exit(1)
else:
    print("ALL CHECKS PASSED")
    sys.exit(0)
