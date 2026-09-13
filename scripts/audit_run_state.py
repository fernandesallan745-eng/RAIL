"""Roster-wide run-state audit: does every Konkan train get a truthful run-day answer?

Offline, cache-only, **zero API calls**.

This is the harness for the layer added because the drawer rendered
``distanceFromOriginKm: 0`` as "0 km covered (0%)" — with the bar painted at a
hardcoded 15% — for trains that were not running that day at all.  A zero that
was never measured looked exactly like a measured zero (VERIFIED #9 at the UI
layer), so the fix was to make the *backend* answer "is this train running
today?" explicitly, and this script is what proves the answer is never a
fabricated default.

What it asserts, per train, per date:

* the payload carries every mandatory key, and ``runsToday`` is **tri-state** —
  ``None`` (calendar unknown) is a different answer from ``False`` (scheduled
  not to run).  Collapsing them is the failure mode this whole layer exists to
  prevent, so a ``False`` that should be ``None`` is a hard fail here.
* ``basis`` is one of the known labels.  An unrecognised basis means the UI's
  label map would fall through to a raw slug on screen.
* ``nextRunDate`` is never earlier than the service date, and when present its
  weekday is actually in ``runDays`` — a next-run date the train does not run on
  is worse than no date at all.
* the answer agrees with ``conflict._runs_on`` computed independently, so
  ``run_state`` cannot drift from the function the crossing sweep uses.

It sweeps **seven consecutive dates** rather than one.  A single date only
exercises one weekday, and 88 of these trains run exactly one day a week — a
one-date audit would leave six sevenths of the calendar logic untested.

Run: ``python3 scripts/audit_run_state.py [YYYY-MM-DD] [days]``
"""
import collections
import datetime
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import conflict as C          # noqa: E402

# Every basis `run_state` and the gateway can emit.  Kept here as an explicit
# allow-list so a new basis added to conflict.py fails this audit until the UI's
# label map in app.js `renderRunState` learns it too — otherwise the page would
# silently render a raw slug like "roster-run-days" to an operator.
KNOWN_BASES = {
    "roster-run-days",     # calendar said yes/no from run_days
    "no-calendar",         # train exists, calendar absent -> runsToday None
    "not-a-corridor-train",
    "no-run-days",         # _runs_on's own label for a missing calendar
}

MANDATORY = ("train", "serviceDate", "runsToday", "runDays",
             "nextRunDate", "basis", "isCorridorTrain", "note")

WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def audit_one(num, day, failures):
    """Check a single train/date answer.  Appends to `failures`; returns the row."""
    rs = C.run_state(num, day.isoformat())
    tag = f"{num}@{day.isoformat()}"

    missing = [k for k in MANDATORY if k not in rs]
    if missing:
        failures.append(f"{tag}: missing keys {missing}")

    if rs.get("basis") not in KNOWN_BASES:
        failures.append(f"{tag}: unknown basis {rs.get('basis')!r} "
                        f"(add it to KNOWN_BASES *and* to app.js basisNote)")

    runs = rs.get("runsToday")
    if runs not in (True, False, None):
        failures.append(f"{tag}: runsToday is {runs!r}, not tri-state")

    days = rs.get("runDays")

    # Tri-state integrity: no calendar must mean None, never a confident False.
    if not days and runs is False:
        failures.append(f"{tag}: runsToday=False with no runDays — that is a "
                        f"fabricated 'no' where the answer is 'unknown'")
    if days and runs is None:
        failures.append(f"{tag}: runDays present but runsToday=None")

    nxt = rs.get("nextRunDate")
    if nxt:
        nd = datetime.date.fromisoformat(nxt)
        if nd < day:
            failures.append(f"{tag}: nextRunDate {nxt} precedes service date")
        if days and WEEKDAYS[nd.weekday()] not in {str(x).lower()[:3] for x in days}:
            failures.append(f"{tag}: nextRunDate {nxt} is a "
                            f"{WEEKDAYS[nd.weekday()]} but runDays={days}")
        # A train that does run today must report today (nextRunDate is inclusive).
        if runs is True and nd != day:
            failures.append(f"{tag}: runs today but nextRunDate={nxt} != {day}")
    elif runs is False and days:
        # 8-day search window vs a weekly calendar: a gap this size cannot happen.
        failures.append(f"{tag}: not running and runDays={days}, yet no nextRunDate "
                        f"within {C.NEXT_RUN_SEARCH_DAYS} days")

    # Independent cross-check against the function the crossing sweep uses, so
    # the two can never drift apart (VERIFIED #12/#22 — one rule, one place).
    if rs.get("isCorridorTrain"):
        try:
            train = C.load_corridor_train(num)
            ref_runs, ref_basis = C._runs_on(train, day, 0)
            # `_runs_on` returns True for a calendar-less train (include and flag);
            # run_state reports None for the same case.  Only compare where the
            # calendar exists.
            if train.get("run_days") and bool(ref_runs) != bool(runs):
                failures.append(f"{tag}: run_state={runs} but _runs_on="
                                f"{ref_runs} (basis {ref_basis})")
        except FileNotFoundError:
            failures.append(f"{tag}: isCorridorTrain=True but load_corridor_train raised")

    return rs


def main():
    start = (datetime.date.fromisoformat(sys.argv[1]) if len(sys.argv) > 1
             else datetime.date.today())
    span = int(sys.argv[2]) if len(sys.argv) > 2 else 7

    trains = C.list_corridor_trains()
    print(f"roster trains: {len(trains)}")
    print(f"dates swept  : {start.isoformat()} .. "
          f"{(start + datetime.timedelta(days=span - 1)).isoformat()} ({span} days)\n")

    failures = []
    per_date = []
    basis_hist = collections.Counter()
    rundays_hist = collections.Counter()

    for i in range(span):
        day = start + datetime.timedelta(days=i)
        runs = notruns = unknown = 0
        for num in trains:
            rs = audit_one(num, day, failures)
            basis_hist[rs.get("basis")] += 1
            if rs.get("runsToday") is True:
                runs += 1
            elif rs.get("runsToday") is False:
                notruns += 1
            else:
                unknown += 1
        total = runs + notruns + unknown
        per_date.append((day, runs, notruns, unknown, total))
        flag = "" if total == len(trains) else "  <-- COUNT MISMATCH"
        print(f"  {day.isoformat()} {day.strftime('%a')} | runs {runs:4d} | "
              f"not running {notruns:4d} | unknown {unknown:3d} | total {total:4d}{flag}")
        if total != len(trains):
            failures.append(f"{day}: states sum to {total}, not {len(trains)}")

    # run_days distribution — the measured 59-daily / 88-single-day split that
    # makes this layer necessary in the first place.
    for num in trains:
        try:
            days = C.load_corridor_train(num).get("run_days") or []
        except FileNotFoundError:
            days = []
        rundays_hist[len(days)] += 1

    print("\nrun_days per train (how many days a week it runs):")
    for n in sorted(rundays_hist):
        label = "no calendar cached" if n == 0 else f"{n} day/week"
        print(f"  {label:22s} {rundays_hist[n]:4d} trains")

    print("\nbasis histogram (all trains x all dates):")
    for b, n in basis_hist.most_common():
        print(f"  {b:24s} {n:5d}")

    # A non-corridor train must be named as such, not answered with a guess.
    off = C.run_state("22487", start.isoformat())
    print(f"\noff-corridor control (22487 Delhi-Amritsar VB): "
          f"basis={off['basis']} runsToday={off['runsToday']!r} "
          f"isCorridorTrain={off['isCorridorTrain']}")
    if off["basis"] != "not-a-corridor-train" or off["runsToday"] is not None:
        failures.append("off-corridor control did not report not-a-corridor-train/None")

    # Determinism: the same question twice must give the same answer.
    probe = trains[0]
    if C.run_state(probe, start.isoformat()) != C.run_state(probe, start.isoformat()):
        failures.append(f"{probe}: run_state is not deterministic")

    checks = len(trains) * span
    print(f"\nchecked {checks} train-date answers "
          f"({len(trains)} trains x {span} dates), 0 API calls")

    if failures:
        print(f"\nFAILURES: {len(failures)}")
        for f in failures[:40]:
            print(f"  - {f}")
        if len(failures) > 40:
            print(f"  ... and {len(failures) - 40} more")
        return 1

    print("\nALL CHECKS PASSED — every train-date answer is one of "
          "runs / does-not-run / unknown, with a known basis and a "
          "consistent next-run date.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
