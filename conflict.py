"""
conflict.py — crossing & overtake prediction on single-line track (Phase 5).

The problem
-----------
Every existing ETA layer in this project is *intra-train*: baseline speed,
curvature, dwell, historical delay.  None of them know that on single line a
train can sit in a loop for 15-25 minutes purely because something with higher
precedence is coming the other way.  On the Konkan single line that is one of
the largest unmodelled sources of delay.

The insight that makes it cheap
-------------------------------
A crossing falls out of **two timetables plus our train's current delay**.  It
does NOT need the other train's live position.  Timetables are static, already
cached by `scripts/build_corridor.py`, and never expire — so this whole module
makes **zero upstream requests**.  (Calling get_live_status() per candidate
train would trip RailRadar's 10 req/min ceiling and burn ~1.5% of a monthly key
on every evaluation.)

How a meet is located
---------------------
Walk the stations the two trains share, in *our* direction of travel, and track

    gap(station) = our_time_there - their_time_there

For an opposing train the gap runs from strongly negative to strongly positive,
so it crosses zero exactly once: that zero is the meet.  For a same-direction
train the gap crosses zero only if we actually catch and pass them, so the same
sign-flip test detects an overtake.  Linear interpolation between the two
bracketing stations gives the meet's km, clock time and lat/lng.

Delay is the payload: shifting our times by +N minutes moves every meet point,
which is precisely the thing a static timetable cannot tell you.

WHAT IS ASSUMED HERE (do not let this drift out of the UI)
----------------------------------------------------------
* **Loop locations are assumed, not sourced.**  This data source carries no
  track-count or loop-length data at all (`platform` exists for booked halts
  only, and is the platform in use).  Every timetable station on the single-line
  section is treated as able to hold a crossing.
* **The priority ladder is our heuristic** over the `type` string, not official
  Indian Railways precedence.  Real precedence is a Section Controller's
  judgement call and can go the other way for operational reasons.
* **Other trains' times are scheduled**, not live.  Only our delay is live.
* `REACCEL_MIN` is an assumption, surfaced in the payload rather than buried.
* Output is a **prediction for a human controller to confirm**.  Nothing here
  issues, or is intended to inform automatically, any control or signalling
  action.

    python3 conflict.py --train 12051
    python3 conflict.py --train 12051 --delay 45
    python3 conflict.py --train 22229 --delay 150
"""
import os, sys, json, glob, bisect, argparse, datetime

import corridor_axis as axis
import corridor_geometry

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache")
CORRIDOR = os.path.join(CACHE, "corridor")
FULL_DATASET_PATH = os.path.join(CACHE, "konkan_full_corridor_trains.json")

# --- Modelling constants (assumptions — all surfaced in the payload) ---------

# Minutes lost to braking into a loop, standing, and restarting from a dead
# stand.  A held train does not resume at line speed.  Not measured from data;
# a stated planning figure.
REACCEL_MIN = 3.0

# CSMT -> Roha is Central Railway DOUBLE line: trains pass each other there with
# no hold whatsoever.  Konkan Railway (Roha -> Madgaon) is single line.  The
# boundary is found by station code so it stays correct for trains running in
# either direction; this constant is only the fallback.
ROHA_FALLBACK_KM = 142.2
SECTION_ANCHORS = ("ROHA", "MAO")

# A train must place at least this many stations on the single-line section
# before a crossing can be located at all.  Two is not a tunable threshold: one
# station is a point, and a point has no traversal for another train's path to
# intersect.  25 of the 206 roster trains touch the section exactly once.
MIN_SINGLE_LINE_STATIONS = 2

# A train must share this much of the single-line section before a crossing with
# it is meaningful.  Goa Express (12779/12780) joins the route only at Madgaon
# and shares 3 stations — excluded here on physical grounds, not by a magic count.
#
# The COUNT was 4 and that was the magic number, not the span.  Two is the
# mathematical floor: interpolating the other train's clock onto our chainage
# needs two anchors and nothing more.  Everything 4 was standing in for is
# already measured elsewhere — the *physical* overlap by MIN_SHARED_SPAN_KM
# (which is what actually excludes Goa Express, sharing 3 stations over a few km
# at Madgaon), and the *looseness* of a meet by anchorMaxGapKm, reported per row.
# Measured cost of the old value: 2103 counterpart pairs over the first 60 trains
# were rejected by the count alone while passing the span test, including every
# counterpart of 10109 Madgaon-Karwar (3 stations, 60.3 km — a tight, entirely
# real overlap) and both Ernakulam Durontos.
MIN_SHARED_IN_SECTION = 2
MIN_SHARED_SPAN_KM = 25.0

# Anchor spacing at which a meet stops being precisely located.  Not a rejection
# threshold — a LABEL.  The other train's clock is linear between anchors, so a
# meet interpolated across a 250 km gap is a real crossing at an approximate
# place, and the payload must say which it is rather than presenting both at the
# same confidence.  Measured on accepted meets: median 51 km, p90 125 km,
# max 251 km — looseness was already present under the old count gate, just
# unlabelled.
ANCHOR_GAP_FINE_KM = 25.0
ANCHOR_GAP_MODERATE_KM = 80.0

# Corridor-wide dedup tolerance (see `corridor_conflicts`).  Two views of ONE
# physical meet disagree by at most about half the coarser view's anchor gap,
# because that gap IS the location uncertainty — so the km tolerance is derived
# from the data per pair, not fixed.  The clock tolerance is fixed at 30 min.
#
# Measured over the 2026-09-11 sweep: of 417 same-pair-same-kind neighbour
# deltas, 249 sit within 5 km/10 min, 314 within 25 km/30 min, 321 within
# 50 km/45 min, and only 5 more appear out to 100 km/60 min.  The curve
# flattens there, which is the signature of ~321 true duplicates and ~96
# genuinely separate events — so a tolerance in that flat region separates them
# without over-merging.  The counter-example the rule must NOT merge is
# 01132/09029 overtake, whose two rows are 140 km and 3.5 h apart.
CORRIDOR_DEDUP_MIN = 30.0
CORRIDOR_DEDUP_KM_FLOOR = 2.0
CORRIDOR_DEDUP_GAP_FRACTION = 0.5

# A train's journey can span several days, so the instance occupying our
# corridor today may have departed 1-2 days ago.  Scanning only offset 0 finds
# 2 of 12051's 5 crossings (VERIFIED #16).
#
# (0, -1, -2) was not a conservative window, it was a WRONG one — it shifts the
# other train only EARLIER.  See `_offset_window`.  Kept as an explicit override
# so the old behaviour is still reproducible.
LEGACY_OFFSETS = (0, -1, -2)

# Sentinel: derive the window per candidate pair.  This is the default.
AUTO_OFFSETS = "auto"
DEFAULT_OFFSETS = AUTO_OFFSETS

# Widening either side of the exactly-needed offset, for a corridor occupancy
# window that straddles midnight.  One day is sufficient and measured: going to
# 2 finds no additional crossing on any roster train.
OFFSET_MARGIN_DAYS = 1

# Ordered longest-match-first: 'JAN SHATABDI' contains 'SHATABDI', so the plain
# SHATABDI rule must never be reached first.  Rank 1 = highest precedence.
PRIORITY_RULES = [
    ("VANDE BHARAT", 1, "Vande Bharat"),
    ("RAJDHANI",     1, "Rajdhani"),
    ("TEJAS",        1, "Tejas"),
    ("DURONTO",      1, "Duronto"),
    ("GATIMAAN",     1, "Gatimaan"),
    ("JAN SHATABDI", 3, "Jan Shatabdi"),
    ("SHATABDI",     2, "Shatabdi"),
    ("GARIB RATH",   4, "Garib Rath"),
    ("SUPERFAST",    4, "Superfast"),
    ("MAIL",         5, "Mail/Express"),
    ("EXPRESS",      5, "Mail/Express"),
    ("PASSENGER",    6, "Passenger"),
    ("MEMU",         6, "MEMU/DEMU"),
    ("DEMU",         6, "MEMU/DEMU"),
]
UNKNOWN_RANK = 6


def normalise_type(raw):
    """'MAIL/EXPRESS' | 'MAIL EXPRESS' | 'Mail/Express' -> ('Mail/Express', 5).

    The source spells the same type several ways and varies its case, so a raw
    string comparison silently splits one class into three.  `category` is not a
    usable substitute: it has only three values (Premium/Express/Special), which
    collapses Superfast and Mail/Express together.
    """
    if not raw:
        return ("Unknown", UNKNOWN_RANK)
    s = " ".join(str(raw).upper().replace("/", " ").replace("-", " ").split())
    for pattern, rank, label in PRIORITY_RULES:
        if pattern in s:
            return (label, rank)
    return (str(raw).title(), UNKNOWN_RANK)


# --- Loading -----------------------------------------------------------------

# Full dataset (206 conflict-relevant trains) — loaded once and cached here.
_full_dataset_cache = None


def _load_full_dataset():
    """Load konkan_full_corridor_trains.json once; return dict keyed by train_number."""
    global _full_dataset_cache
    if _full_dataset_cache is not None:
        return _full_dataset_cache
    if not os.path.exists(FULL_DATASET_PATH):
        _full_dataset_cache = {}
        return _full_dataset_cache
    with open(FULL_DATASET_PATH) as f:
        raw = json.load(f)
    _full_dataset_cache = {
        str(r["train_number"]): r
        for r in raw.get("trains", [])
        if r.get("conflict_relevant")
    }
    return _full_dataset_cache


def _hhmm_to_min(hhmm, day=1):
    """'HH:MM' + 1-based journey day -> day-normalised integer minutes."""
    if not hhmm:
        return None
    try:
        h, m = map(int, str(hhmm).strip().split(":"))
        return (int(day) - 1) * 1440 + h * 60 + m
    except (ValueError, AttributeError):
        return None


def adapt_full_dataset_train(record):
    """Convert a konkan_full_corridor_trains record to the format conflict.py expects.

    The two formats differ in three ways:
    - km axis: new format has `trainKm` inside `scheduled`; model wants top-level `km`
    - times: new format has 'HH:MM' strings + arrDay/depDay integers; model wants
      day-normalised integer minutes as `arrMin`/`depMin`
    - lat/lng: not present in the new format; meet coords degrade to 'unavailable'
      (that path is already handled at conflict.py:363-364)

    Only corridor_stations (halt stations) are available — non-halt pass-through
    stations are absent.  This is NOT harmless, and the walk compensates for it.
    A halts-only train can share as few as 5 stations with ours, so consecutive
    shared stations sit up to ~140 km apart; read as one block section, that
    charged 22229 a 123 min wait for a Rajdhani to clear track the two would
    really have crossed at an intermediate station.  `find_conflicts` therefore
    treats the shared codes as ANCHORS for the other train's clock and walks OUR
    own station list, surfacing `anchorCount` / `anchorMaxGapKm` /
    `otherTimesBasis` on every row so a loosely-located meet is visible rather
    than implied.
    """
    stations = []
    for s in record.get("corridor_stations", []):
        sched = s.get("scheduled") or {}
        arr_day = sched.get("arrDay", sched.get("day", 1))
        dep_day = sched.get("depDay", sched.get("day", 1))
        arr_min = _hhmm_to_min(sched.get("arr"), arr_day)
        dep_min = _hhmm_to_min(sched.get("dep"), dep_day)
        if arr_min is None and dep_min is None:
            continue                                 # no usable time — skip
        km_val = sched.get("trainKm")
        if km_val is None:
            continue                                 # no km — can't place on axis
        stations.append({
            "code":    s["code"],
            "name":    s.get("name", ""),
            "km":      float(km_val),
            "arrMin":  arr_min,
            "depMin":  dep_min,
            "isHalt":  sched.get("stopType", "halt") != "pass",
            # lat/lng absent — meet coords will report 'unavailable' for these trains
        })

    # Prefer the train payload type for precedence (resolves 12051/12052 rank change).
    train_type = record.get("category_train_payload") or record.get("category")

    return {
        "number":      record["train_number"],
        "name":        record.get("train_name"),
        "type":        train_type,
        "category":    record.get("category_station_board"),
        "run_days":    record.get("run_days"),
        "source":      record.get("origin"),
        "destination": record.get("destination"),
        "stations":    stations,
        "_source":     "full-dataset",              # audit trail
    }


def get_train_delay(train_number, service_date=None):
    """
    Look up the empirical or live delay for a train on the corridor.
    Checks:
    1. Canonical dated run for `service_date` if provided (.cache/{train}_live_{service_date}.json)
    2. Latest live snapshot (.cache/{train}_live.json or .cache/train_{train}_live_fallback.json)
    3. Any dated runs in .cache/{train}_live_*.json

    Returns (delay_min, basis, date_or_None).
    If no valid signal is found, returns (0.0, 'scheduled-on-time', None).
    """
    tr = str(train_number)
    candidates = []
    if service_date:
        sd_str = service_date.strftime("%Y-%m-%d") if isinstance(service_date, (datetime.date, datetime.datetime)) else str(service_date)
        candidates.append(os.path.join(CACHE, f"{tr}_live_{sd_str}.json"))
    candidates.append(os.path.join(CACHE, f"{tr}_live.json"))
    candidates.append(os.path.join(CACHE, f"train_{tr}_live_fallback.json"))
    candidates.extend(sorted(glob.glob(os.path.join(CACHE, f"{tr}_live_*.json")), reverse=True))

    for path in candidates:
        if not os.path.exists(path):
            continue
        try:
            with open(path) as f:
                d = json.load(f)
            halts = [s for s in d.get("route", []) if s.get("isHalt")]
            if len(halts) >= 2 and halts[-1].get("delayArrival") is not None:
                delay = float(halts[-1]["delayArrival"])
                date_found = d.get("startDate") or os.path.basename(path).split("_live_")[-1].replace(".json", "")
                return delay, "cached-dated-run", date_found
            elif d.get("trackingMode") == "real-time" and d.get("delayMinutes") is not None:
                delay = float(d.get("delayMinutes"))
                return delay, "cached-live-snapshot", d.get("startDate")
        except Exception:
            continue
    return 0.0, "scheduled-on-time", None


def load_corridor_train(number):
    """Load one train's schedule in the format the conflict model expects.

    Preference order:
    1. `.cache/corridor/{number}.json` — built by build_corridor.py from a live
       fallback.  Richer: includes non-halt pass-through stations and lat/lng.
    2. `konkan_full_corridor_trains.json` — the complete 206-train roster built
       by fetch_konkan_corridor + build_konkan_dataset.  Halt stations only, no
       lat/lng, but covers 189 trains the corridor cache does not have.
    """
    path = os.path.join(CORRIDOR, f"{number}.json")
    if os.path.exists(path):
        with open(path) as f:
            train = json.load(f)
        # The corridor cache is built from a live fallback, which carries no
        # calendar; the roster does.  Without this backfill the 17 richest
        # trains — including both demo trains — are the only ones the run-day
        # filter cannot see, so 22229 (Mon/Wed/Fri) would be modelled as
        # crossing 22119 Tejas (Tue/Thu/Sat), a meet that cannot happen.
        if not train.get("run_days"):
            record = _load_full_dataset().get(str(number))
            if record and record.get("run_days"):
                train["run_days"] = record["run_days"]
                train["run_days_source"] = "full-dataset-backfill"
        return axis.annotate(train)

    full = _load_full_dataset()
    record = full.get(str(number))
    if record is not None:
        return axis.annotate(adapt_full_dataset_train(record))

    raise FileNotFoundError(
        f"Train {number} not found in corridor cache ({CORRIDOR}) "
        f"or full dataset ({FULL_DATASET_PATH}).\n"
        f"Run: python3 scripts/build_corridor.py  (for the 17 live-tracked trains)\n"
        f"Run: python3 scripts/build_konkan_dataset.py  (for the full 206-train roster)"
    )


def list_corridor_trains():
    """All train numbers available to the conflict model.

    Returns numbers from both sources, deduplicated, with the corridor cache
    (richer format) preferred for any train in both.  fleet_fallback is excluded
    by the glob pattern (it is not named like a train number).
    """
    from_corridor = {
        os.path.basename(p)[:-5]
        for p in glob.glob(os.path.join(CORRIDOR, "*.json"))
        if os.path.basename(p) != "fleet_fallback.json"
    }
    from_full = set(_load_full_dataset().keys())
    return sorted(from_corridor | from_full)


def station_time(s):
    """Time at a station, in day-normalised minutes.

    Arrival where it exists, departure otherwise — the origin row has no
    arrival, and at non-halt stations the two are equal anyway.
    """
    t = s.get("arrMin")
    return t if t is not None else s.get("depMin")


def single_line_span(train):
    """(lo_km, hi_km, basis) of single-line track on THIS train's own axis.

    RETAINED AS A FALLBACK ONLY.  `single_line_membership` below is what
    `find_conflicts` uses; this runs only when the canonical axis is missing
    entirely (the dataset file is absent).  Both of its branches were wrong and
    are fixed here rather than left as a trap:

    * **One-anchor branch picked the wrong side of Roha for every up train.**
      "Single line runs from Roha to the far end" is true only for a train whose
      far end is Madgaon.  01446 runs Ratnagiri -> Panvel, so its far end is
      PNVL at own-km 278.2 and the branch returned [203.8, 278.2] — the Central
      Railway DOUBLE line — instead of [0.0, 203.8].  113 of the 206 roster
      trains took this branch, and each then rejected all 209 counterparts as
      "shares too little of the single-line section".  Orientation now comes
      from a second canonical station rather than from an assumption.
    * **Fallback branch returned its pair unsorted**, so any train whose own
      axis ends before km 142.2 got an inverted span that can contain nothing
      (07361 -> [142.2, 24.6]).
    """
    km = {s["code"]: s["km"] for s in train["stations"]}
    roha, mao = km.get(SECTION_ANCHORS[0]), km.get(SECTION_ANCHORS[1])
    if roha is not None and mao is not None:
        lo, hi = sorted((roha, mao))
        return lo, hi, "anchored:ROHA-MAO"

    if roha is not None:
        # Orient off any OTHER station the canonical axis knows: whichever side
        # of Roha carries a station with positive canonical km is the Konkan
        # side.  Falls back to the far end only when nothing can orient it.
        for s in train["stations"]:
            ck = s.get("corridorKm")
            if ck is not None and ck > 0 and s["code"] != SECTION_ANCHORS[0]:
                lo, hi = sorted((roha, s["km"]))
                # Extend to the far end on that same side of Roha.
                same_side = [t["km"] for t in train["stations"]
                             if (t["km"] - roha) * (s["km"] - roha) >= 0]
                return min(same_side), max(same_side), "anchored:ROHA+oriented"
        far = max(s["km"] for s in train["stations"])
        lo, hi = sorted((roha, far))
        return lo, hi, "anchored:ROHA-only-unoriented"

    lo, hi = sorted((ROHA_FALLBACK_KM, max(s["km"] for s in train["stations"])))
    return lo, hi, "fallback-km"


def single_line_membership(train):
    """(test, basis, note) — is a given station of `train` on single line?

    The canonical `section` label is authoritative: it needs no anchor, no
    direction inference and no arithmetic, and it is consistent to zero
    disagreements across all 1859 dataset records (`corridor_axis.audit()`).
    A station code the axis does not know is **off the Konkan corridor**, not
    unclassified — measured: the 1052 unknown codes are Ernakulam, Bikaner,
    Jhansi and the like, reached by corridor trains on the rest of their long
    journeys.  Answering False for them is the correct classification, not a
    lossy default.

    Only when the dataset file itself is absent does this degrade to the
    km-span heuristic, and it says so in the basis (the `axisBasis` pattern of
    VERIFIED #12 — degrade loudly, never silently).
    """
    if axis.available():
        return (lambda s: s.get("onSingleLine") is True,
                "canonical-section",
                "Station-level `section` label from the corridor dataset; "
                "direction-agnostic and independent of the train's own km origin.")

    lo, hi, basis = single_line_span(train)
    return (lambda s: lo <= s["km"] <= hi,
            f"fallback:{basis}",
            "Canonical corridor axis unavailable — section inferred from this "
            "train's own km axis, which is unreliable for up trains.")


# --- Core --------------------------------------------------------------------

def _interp(a, b, f):
    if a is None or b is None:
        return None
    return a + f * (b - a)


def _piecewise_at(xs, ys, x):
    """Linear interpolation of `ys` over strictly-increasing `xs`, evaluated at `x`.

    Used to read the other train's clock at one of OUR stations.  Clamped at both
    ends rather than extrapolated: outside the outermost shared station we have no
    evidence of where the other train is, and the caller never asks outside that
    span (`nodes` is clipped to it).
    """
    if x <= xs[0]:
        return ys[0]
    if x >= xs[-1]:
        return ys[-1]
    i = bisect.bisect_right(xs, x) - 1
    x0, x1 = xs[i], xs[i + 1]
    if x1 == x0:
        return ys[i]
    return ys[i] + (x - x0) / (x1 - x0) * (ys[i + 1] - ys[i])


def _clock(minutes):
    """Day-normalised minutes -> 'HH:MM' (+1d marker for a later journey day)."""
    if minutes is None:
        return None
    day, mod = divmod(int(round(minutes)), 1440)
    return f"{mod // 60:02d}:{mod % 60:02d}" + (f" +{day}d" if day else "")


WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def _runs_on(train, service_date, offset_days):
    """Does this train's run occupy our corridor on `service_date`?

    Returns (bool, basis).  `offset_days` is the instance offset already used to
    place the run: an instance on its own day 2 DEPARTED a day earlier, so the
    run-day to test is the service date shifted by that offset.

    Only 59 of the 206 roster trains run daily.  88 run on exactly one day a
    week, so an unfiltered scan charges a crossing with a Thursday-only special
    to a Monday run — 09022 (Thu) and 09124 (Mon) are a measured example: both
    were being billed 7.7 min at the identical km, and they can never both be
    there.  Any given weekday has 85-98 of the 206 actually running.

    A train with no `run_days` (the 17 corridor-cache files, which are built from
    a live fallback and carry no calendar) is INCLUDED and flagged rather than
    dropped: excluding it would silently lose real crossings.
    """
    days = train.get("run_days")
    if not days:
        return True, "no-calendar"
    if service_date is None:
        return True, "no-service-date"
    d = service_date + datetime.timedelta(days=offset_days)
    return (WEEKDAYS[d.weekday()] in {str(x).lower()[:3] for x in days},
            "run-days")


#: How far ahead `run_state` will look for the next service before giving up.
#: 8 rather than 7 so a train that runs only on `service_date`'s own weekday
#: reports next week's date instead of "none in range" — the 88 single-day
#: trains are exactly the ones a user most needs a next-service date for.
NEXT_RUN_SEARCH_DAYS = 8


def run_state(number, service_date=None):
    """Does train `number` run on `service_date`, and if not, when next?

    This is the calendar half of the UI's run-state answer; the live half
    (`running` / `completed` / `not-started`) outranks it and is resolved by the
    gateway, which has the live payload.  Only the roster knows the calendar, so
    only this side can answer "not running today".

    Deliberately reuses `_runs_on` rather than re-deriving the weekday test:
    that function already encodes the measured 59-daily / 88-single-day
    distribution and the "no calendar means INCLUDE and flag" rule, and a second
    copy of the rule in another language is exactly the drift this project keeps
    getting bitten by (VERIFIED #12/#22).

    `runs_today` is **tri-state on purpose**.  `None` means the calendar is
    unknown, which is a different answer from `False` ("scheduled not to run"),
    and flattening the two would be VERIFIED #9 at the calendar layer — the same
    mistake the crossings panel made when it rendered "no crossings" for trains
    that could not be computed at all.

    `nextRunDate` is **inclusive of `service_date`**: a train running today
    reports today.  The UI only reads it on the not-running branch, where the
    ambiguity cannot arise.
    """
    d = _parse_date(service_date) or datetime.date.today()

    try:
        train = load_corridor_train(number)
    except FileNotFoundError:
        return {
            "train": str(number),
            "serviceDate": d.isoformat(),
            "runsToday": None,
            "runDays": None,
            "nextRunDate": None,
            "basis": "not-a-corridor-train",
            "isCorridorTrain": False,
            "note": (f"Train {number} is not on the Konkan corridor roster, so no "
                     f"run calendar is available for it here."),
        }

    runs, basis = _runs_on(train, d, 0)
    days = train.get("run_days")
    name = train.get("name")

    # No calendar: say so, never guess. `_runs_on` returns True for these so the
    # crossing sweep keeps them, but "included in the sweep" is not evidence the
    # train runs today and must not be reported as such.
    if not days:
        return {
            "train": str(number),
            "serviceDate": d.isoformat(),
            "runsToday": None,
            "runDays": None,
            "nextRunDate": None,
            "basis": "no-calendar",
            "isCorridorTrain": True,
            "trainName": name,
            "note": (f"No run calendar is cached for train {number}, so whether it "
                     f"runs on {d.isoformat()} is unknown — not a 'no'."),
        }

    day_set = {str(x).lower()[:3] for x in days}
    ordered = [w for w in WEEKDAYS if w in day_set]

    next_run = None
    for step in range(0 if runs else 1, NEXT_RUN_SEARCH_DAYS):
        cand = d + datetime.timedelta(days=step)
        if WEEKDAYS[cand.weekday()] in day_set:
            next_run = cand
            break

    if runs:
        note = f"Runs on {d.strftime('%a %d %b')}."
    else:
        nxt = (f" Next service {next_run.strftime('%a %d %b')}."
               if next_run else "")
        note = (f"Does not run on {d.strftime('%A')}. "
                f"Scheduled days: {', '.join(w.capitalize() for w in ordered)}.{nxt}")

    return {
        "train": str(number),
        "serviceDate": d.isoformat(),
        "runsToday": bool(runs),
        "runDays": ordered,
        "nextRunDate": next_run.isoformat() if next_run else None,
        "basis": "roster-run-days" if basis == "run-days" else basis,
        "isCorridorTrain": True,
        "trainName": name,
        "note": note,
    }


def _parse_date(value):
    """'YYYY-MM-DD' | date | None -> date | None. Never raises on a bad string."""
    if value is None or isinstance(value, datetime.date):
        return value
    try:
        return datetime.datetime.strptime(str(value)[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def _location_confidence(anchor_gap_km):
    """How precisely a meet is located, from the widest anchor gap behind it.

    'fine'     — anchors about a block apart; the meet sits between two stations
                 whose times we actually know for both trains.
    'moderate' — several blocks; the km is good to roughly a block.
    'coarse'   — the other train's clock is a straight line across a long
                 unanchored stretch. The crossing is real (two timetables do
                 cross); WHERE it happens is approximate.
    """
    if anchor_gap_km <= ANCHOR_GAP_FINE_KM:
        return "fine"
    if anchor_gap_km <= ANCHOR_GAP_MODERATE_KM:
        return "moderate"
    return "coarse"


def _charge_hold(c, excess_min):
    """Charge a conflict row only the wait it adds OVER the on-time plan.

    `excess_min` is `rawWaitMin - scheduledWaitMin`.  A booked timetable already
    absorbs its planned crossings inside its block times, so only the excess is
    a real cost; a negative excess (the delay happened to improve the meet) is
    floored at zero rather than credited, because a train cannot bank time it
    was never scheduled to lose.

    REACCEL_MIN rides on top only when something is actually charged.  Adding it
    to a zero excess would make every planned crossing cost exactly the constant
    — and a hold that lands exactly on a modelling constant is the bug signature
    VERIFIED #20 was found by.
    """
    excess = max(0.0, round(excess_min, 6))
    hold = round(excess + REACCEL_MIN, 1) if excess > 0 else 0.0
    if c["whoIsHeld"] == "us":
        c["ourHoldMin"], c["theirHoldMin"] = hold, 0.0
    else:
        c["ourHoldMin"], c["theirHoldMin"] = 0.0, hold
    c["excessWaitMin"] = round(excess, 1)


def corridor_day_span(train, on_single_line):
    """(first_day, last_day) of this train's own journey spent on single line.

    Day 0 is its departure day, read off the day-normalised minute axis of
    VERIFIED #16.  None when it places no timed station on the section.
    """
    ts = [station_time(s) for s in train.get("stations") or []
          if on_single_line(s)]
    ts = [t for t in ts if t is not None]
    if not ts:
        return None
    return min(ts) // 1440, max(ts) // 1440


def _offset_window(our_days, their_days, margin=OFFSET_MARGIN_DAYS):
    """Departure-day offsets at which `them` could share our corridor window.

    The fixed (0, -1, -2) window only ever shifted the other train EARLIER, so
    it could never find a counterpart that departed LATER in absolute terms.
    That is not a rare case: **65 of the 206 roster trains reach Konkan on their
    own day >= 1** (deepest 06904, days 3-4), and the trains they meet there
    departed one to three days after them.  Measured cost: 02198 Coimbatore
    Special found **0** crossings over 174 usable counterparts, and finds **25**
    once positive offsets are scanned.  A zero that large over a 723 km overlap
    is the signature VERIFIED #9 warns about — a layer reporting nothing looks
    identical to a layer that is switched off.

    Deriving the window removes the constant rather than doubling it.  Their
    corridor day `d` aligns with our corridor day `D` at offset `D - d`, so the
    needed range is `[our_first - their_last, our_last - their_first]`, widened
    by `margin`.

    It is **not** free: measured over 626 pairs the derived window is 3.92
    offsets on average (min 3, max 5) against the old fixed 3, so this is about
    30% more scanning.  Stated because the first version of this docstring
    claimed the opposite.  The floor is 3 rather than 1 because `margin` widens
    a same-day pair to [-1, 0, +1]; what the derivation buys is the *upper*
    end, which no fixed tuple reached.
    """
    lo = our_days[0] - their_days[1] - margin
    hi = our_days[1] - their_days[0] + margin
    return tuple(range(lo, hi + 1))


def find_conflicts(our_number, delay_min=0.0, offsets=DEFAULT_OFFSETS,
                   others=None, service_date=None, _with_baseline=True,
                   other_delays=None, use_live_delays=False,
                   dynamic_feedback=False):
    """Predict every crossing / overtake for one run of `our_number`.

    `delay_min` is applied uniformly to our whole journey — i.e. the delay is
    assumed to be *carried*, not recovered.  That is deliberately pessimistic
    and is stated in the payload as `delayModel`.
    """
    service_date = _parse_date(service_date)
    us = load_corridor_train(our_number)
    our_label, our_rank = normalise_type(us.get("type"))
    skipped_not_running = 0
    # Filtering the OTHER trains but not ourselves leaves the same bug one level
    # up: on a Tuesday, 22229 (Mon/Wed/Fri) does not run at all, yet it was being
    # charged 26.1 min for a crossing with 22119 Tejas (Tue/Thu/Sat).  Reported,
    # not refused — a caller may legitimately model a hypothetical service — but
    # the flag must travel with the answer.
    we_run, our_run_basis = _runs_on(us, service_date, 0)
    on_single_line, section_basis, section_note = single_line_membership(us)
    our_coverage = axis.coverage(us)
    our_corridor_days = corridor_day_span(us, on_single_line)
    offsets_auto = offsets == AUTO_OFFSETS
    offsets_seen = set()

    our_st = {s["code"]: s for s in us["stations"]}

    # A train that places fewer than two stations on the single-line section
    # cannot have a crossing LOCATED, and must say so.  Returning an empty
    # conflicts list with no explanation reads as "no crossings predicted",
    # which is a different and much stronger claim — the zero-layer hazard of
    # VERIFIED #9.  Two populations land here: 25 roster trains that touch the
    # section exactly once, and stray non-corridor trains that have a cache file
    # (12989 Dadar-Ajmer, 22195 Jhansi-Bandra, 22308 Bikaner-Howrah all place
    # ZERO stations on the corridor).
    our_single_line = [s for s in us["stations"] if on_single_line(s)]
    eligible = len(our_single_line) >= MIN_SINGLE_LINE_STATIONS
    ineligible_reason = None
    if not eligible:
        ineligible_reason = (
            "not-a-corridor-train" if not our_single_line
            else "insufficient-corridor-span"
        )

    candidates = ([] if not eligible else
                  others if others is not None else list_corridor_trains())

    conflicts, considered = [], []

    other_delays_applied = {}   # {train_number: {delay, basis, date}}

    for other_number in candidates:
        if str(other_number) == str(our_number):
            continue
        try:
            them = load_corridor_train(other_number)
        except FileNotFoundError:
            continue

        # --- opposing-train delay lookup ---
        their_delay_min = 0.0
        their_delay_basis = "scheduled-on-time"
        their_delay_date = None
        if use_live_delays:
            if other_delays and str(other_number) in other_delays:
                their_delay_min = float(other_delays[str(other_number)])
                their_delay_basis = "caller-provided"
            else:
                their_delay_min, their_delay_basis, their_delay_date = (
                    get_train_delay(other_number, service_date))
        if their_delay_min:
            other_delays_applied[str(other_number)] = {
                "delayMin": round(their_delay_min, 1),
                "basis": their_delay_basis,
                "date": their_delay_date,
            }

        their_st = {s["code"]: s for s in them["stations"]}
        shared_codes = [c for c in our_st if c in their_st]

        # Restrict to the single-line section: a meet on double track needs no
        # hold, so shared stations outside it cannot produce a conflict.
        in_section = [c for c in shared_codes if on_single_line(our_st[c])]
        span = 0.0
        if in_section:
            kms = [our_st[c]["km"] for c in in_section]
            span = max(kms) - min(kms)

        rec = {
            "train": str(other_number),
            "name": them.get("name"),
            "shared": len(shared_codes),
            "sharedInSection": len(in_section),
            "sharedSpanKm": round(span, 1),
        }

        if len(in_section) < MIN_SHARED_IN_SECTION or span < MIN_SHARED_SPAN_KM:
            rec["used"] = False
            rec["reason"] = "shares too little of the single-line section"
            considered.append(rec)
            continue
        rec["used"] = True
        considered.append(rec)

        # Walk in OUR direction of travel.
        anchors = sorted(in_section, key=lambda c: our_st[c]["km"])
        anchors = [c for c in anchors if station_time(our_st[c]) is not None
                   and station_time(their_st[c]) is not None]
        if len(anchors) < 2:
            continue

        # The shared codes ANCHOR the other train's clock to our chainage; they
        # must not also set the RESOLUTION of the walk.  A halts-only source (the
        # 206-train roster) shares as few as 5 stations, so two consecutive
        # anchors can sit 140 km apart with a dozen of our own crossing stations
        # in between — and the hold rule below reads the bracketing pair as ONE
        # block section.  Walking the anchors directly therefore charged 22229 a
        # 123 min wait for a Rajdhani to clear 139.8 km of track the two would
        # really have crossed at one of the intermediate stations.  Interpolating
        # their clock onto OUR stations leaves the meet point where it was and
        # puts the hold on a block that actually exists.
        anchor_km = [our_st[c]["km"] for c in anchors]
        anchor_t = [station_time(their_st[c]) for c in anchors]
        anchor_max_gap = max(y - x for x, y in zip(anchor_km, anchor_km[1:]))

        # Clipped to the anchor span: past the outermost shared station there is
        # no evidence of where the other train is, and clamping out there would
        # invent a flat clock.
        nodes = sorted(
            (s for s in us["stations"]
             if station_time(s) is not None
             and anchor_km[0] <= s["km"] <= anchor_km[-1]),
            key=lambda s: s["km"],
        )
        if len(nodes) < 2:
            continue

        their_time_at = [_piecewise_at(anchor_km, anchor_t, s["km"]) for s in nodes]
        anchor_set = set(anchors)

        # Same direction or opposing?  Their own chainage either rises or falls
        # as we advance.  Offset-independent, so it is decided once.
        their_km_first = their_st[anchors[0]]["km"]
        their_km_last = their_st[anchors[-1]]["km"]
        same_direction = their_km_last > their_km_first
        kind = "overtake" if same_direction else "opposing"

        their_label, their_rank = normalise_type(them.get("type"))

        # Offsets are a property of THIS PAIR's day alignment, not a global
        # constant.  `rec` is already in `considered` and is mutated by
        # reference so the window that was actually scanned is auditable.
        if offsets_auto:
            their_days = corridor_day_span(them, on_single_line)
            pair_offsets = (_offset_window(our_corridor_days, their_days)
                            if our_corridor_days and their_days
                            else LEGACY_OFFSETS)
        else:
            pair_offsets = offsets
        rec["offsetsScanned"] = list(pair_offsets)
        offsets_seen.update(pair_offsets)

        for off in pair_offsets:
            running, run_basis = _runs_on(them, service_date, off)
            if not running:
                skipped_not_running += 1
                continue
            shift = off * 1440
            their_total_shift = shift + their_delay_min
            gaps = [(station_time(s) + delay_min) - (t + their_total_shift)
                    for s, t in zip(nodes, their_time_at)]

            for i in range(len(nodes) - 1):
                g0, g1 = gaps[i], gaps[i + 1]
                # Half-open sign test.  A gap of exactly 0 means the two trains
                # are timetabled to the same minute at that station — which is
                # the normal, planned case for a crossing, not an anomaly.  A
                # naive `(g0<0) != (g1<0)` test treats a bare zero as a flip and
                # can therefore report the SAME meet twice, once from each
                # neighbouring interval.  Attributing the zero to the interval
                # that ENDS at it detects it exactly once.
                if not ((g0 < 0 <= g1) or (g0 > 0 >= g1)):
                    continue
                if g0 == g1:
                    continue                      # guard the interpolation

                f = g0 / (g0 - g1)
                a, b = nodes[i], nodes[i + 1]
                meet_km = _interp(a["km"], b["km"], f)
                meet_t = _interp(station_time(a) + delay_min,
                                 station_time(b) + delay_min, f)

                # Who yields.
                our_t_a = station_time(a) + delay_min
                their_t_a = their_time_at[i] + their_total_shift
                our_t_b = station_time(b) + delay_min
                their_t_b = their_time_at[i + 1] + their_total_shift

                overtaker = None
                precedence_note = None

                # WHO stands aside.
                if same_direction:
                    # An overtake is physically forced: the train being PASSED
                    # takes the loop, whatever the ladder says — you cannot pass
                    # on single line otherwise.  The flip direction says who
                    # passes whom (VERIFIED #20).
                    #   gap + -> - : we were behind at A, ahead at B -> we pass
                    #   gap - -> + : they pass us
                    overtaker = str(our_number) if g0 > 0 else str(other_number)
                    who = "them" if overtaker == str(our_number) else "us"
                    # Precedence does not decide the loop here, but it does
                    # decide whether a controller grants the pass at all.  Flag
                    # the mismatch rather than invent a different number.
                    fast_rank = our_rank if overtaker == str(our_number) else their_rank
                    slow_rank = their_rank if overtaker == str(our_number) else our_rank
                    if fast_rank > slow_rank:
                        precedence_note = (
                            "the overtaking train ranks lower; a controller may "
                            "refuse the pass and hold it behind instead"
                        )
                else:
                    # Head-on: precedence decides, because the controller chooses
                    # WHERE to cross the pair and can give the higher-ranked train
                    # a clear run by holding the other one back.  Each train can
                    # only ever be held on the side it enters from — we at A, an
                    # opposing train at B.
                    if our_rank < their_rank:
                        who = "them"
                    elif our_rank > their_rank:
                        who = "us"
                    elif our_t_a != their_t_b:
                        who = "us" if our_t_a > their_t_b else "them"
                    else:
                        # Exact tie. `our_t_a > their_t_b` is False from BOTH
                        # trains' axes, so each would conclude the other holds.
                        # The train number is the only tie-break that gives the
                        # two runs the same answer (reciprocity, C-check).
                        who = ("us" if str(our_number) > str(other_number)
                               else "them")

                hold_station = a["code"] if who == "us" else b["code"]

                # HOW LONG.  The wait is the two trains' OCCUPANCY OVERLAP of the
                # A-B section, not the time for one to clear the whole of it.  We
                # hold the section from our departure at A to our arrival at B;
                # an opposing train holds it from its departure at B to its
                # arrival at A.  Only where those windows intersect does anyone
                # actually stand.
                #
                # Clearance-time — `their_t_a - our_t_a`, "wait at A until they
                # have run the whole block" — is what produced 16345's 601.8 min
                # of holds and charged 22229 a 123 min wait for a Rajdhani.  On
                # the SGR-UKC example it bills 48 min for a crossing the working
                # timetable makes at UKC with one minute in hand: 16345 runs
                # 17:10 -> 17:45 while 12052 runs 17:44 -> 17:58, so the windows
                # touch for exactly that minute and nothing more.
                our_in = (a.get("depMin") if a.get("depMin") is not None
                          else station_time(a)) + delay_min
                our_out = our_t_b
                # The other train's clock is interpolated onto our chainage, so
                # there is no separate departure for it; at a non-halt station the
                # two are equal anyway, and every halt it makes is an anchor.
                their_in, their_out = their_t_b, their_t_a
                if same_direction:
                    # Running the same way, both windows point the same way.
                    their_in, their_out = their_t_a, their_t_b
                raw_wait = max(0.0, min(our_out, their_out) - max(our_in, their_in))

                meet_lat = _interp(a.get("lat"), b.get("lat"), f)
                meet_lng = _interp(a.get("lng"), b.get("lng"), f)
                coords_basis = ("interpolated" if meet_lat is not None
                                and meet_lng is not None else "unavailable")

                # The same meet on the CANONICAL axis.  meetKm (below) is on our
                # own km origin, which is what eta_model buckets holds by and
                # what the drawer shows; but two trains' own axes disagree about
                # the same physical point, so anything comparing meets ACROSS
                # trains (the corridor-wide view) must use this one.
                meet_corridor_km = _interp(a.get("corridorKm"),
                                           b.get("corridorKm"), f)

                if coords_basis == "unavailable" and meet_corridor_km is not None:
                    # Fall back to the SHARED alignment.  Own-station coordinates
                    # exist only for trains cached with includeCoordinates=true
                    # (VERIFIED #13) — 0 of the 1859 full-dataset records carry
                    # them, so without this the corridor view could draw 1.7% of
                    # its meets.  Sound here because every row in this loop is
                    # on the single-line section, where the corridor's trains
                    # genuinely share one track; north of Roha they do not
                    # (12051 via Trans-Harbour diverges from the 22229 reference
                    # by up to 10.3 km) and `point_at_corridor_km` must not be
                    # used there.  Kept as a DISTINCT basis value rather than
                    # relabelled "interpolated": these two are different claims
                    # about where the number came from.
                    pt = corridor_geometry.point_at_corridor_km(meet_corridor_km)
                    if pt is not None:
                        meet_lat, meet_lng, _ref = pt
                        coords_basis = "shared-corridor-polyline"

                conflicts.append({
                    "otherTrain": str(other_number),
                    "otherName": them.get("name"),
                    "otherTypeRaw": them.get("type"),
                    "otherType": their_label,
                    "otherPriority": their_rank,
                    "ourTrain": str(our_number),
                    "ourType": our_label,
                    "ourPriority": our_rank,
                    "kind": kind,
                    "meetKm": round(meet_km, 1),
                    "meetCorridorKm": (round(meet_corridor_km, 1)
                                       if meet_corridor_km is not None else None),
                    "meetTimeMin": round(meet_t, 1),
                    "meetClock": _clock(meet_t),
                    "meetLat": meet_lat,
                    "meetLng": meet_lng,
                    # Where the coordinates came from, never just whether they
                    # exist.  "interpolated" = between OUR OWN two station rows;
                    # "shared-corridor-polyline" = resolved on a reference
                    # train's real Konkan alignment via the canonical km, which
                    # is the right track but not this train's own route file;
                    # "unavailable" = no marker can be drawn, and the map says
                    # so rather than silently omitting it.
                    "meetCoordsBasis": coords_basis,
                    "betweenFrom": a["code"],
                    "betweenFromName": a.get("name"),
                    "betweenTo": b["code"],
                    "betweenToName": b.get("name"),
                    # The hold is charged for clearing THIS block, so its
                    # length is what makes a hold plausible or absurd.
                    "holdBlockKm": round(b["km"] - a["km"], 1),
                    # Their clock is scheduled AT a shared station and
                    # interpolated between two of them.  A wide anchor gap
                    # means a loosely-located meet -- surfaced, not hidden.
                    "otherTimesBasis": ("scheduled-at-shared-station"
                                        if (a["code"] in anchor_set
                                            and b["code"] in anchor_set)
                                        else "interpolated-between-shared-stations"),
                    "anchorCount": len(anchors),
                    "anchorMaxGapKm": round(anchor_max_gap, 1),
                    "locationConfidence": _location_confidence(anchor_max_gap),
                    "instanceOffsetDays": off,
                    "runDayBasis": run_basis,
                    "isSingleLine": True,
                    "whoIsHeld": who,
                    "overtakingTrain": overtaker,
                    "precedenceNote": precedence_note,
                    # The PHYSICAL wait at the crossing station, before the
                    # on-time plan is netted off.  Kept so the charged hold below
                    # can be audited against the number it came from.
                    "rawWaitMin": round(raw_wait, 1),
                    # Filled in by the baseline pass: only the wait OVER AND
                    # ABOVE the on-time plan is charged (see holdBasis).
                    "ourHoldMin": 0.0,
                    "theirHoldMin": 0.0,
                    "holdStation": hold_station,
                    "holdStationName": (our_st[hold_station] or {}).get("name")
                                       if hold_station else None,
                    "holdBasis": (
                        "overtake: the train being passed takes the loop while the "
                        "faster one passes. No on-time counterpart exists (VERIFIED "
                        "#19), so the whole wait is charged, plus REACCEL_MIN"
                        if same_direction else
                        "head-on: the pair cross at whichever bracketing station "
                        "their timetables are closest at, and whoever arrives first "
                        "stands aside. Only the wait OVER the on-time plan is "
                        "charged — the booked timetable already contains the "
                        "planned crossing — plus REACCEL_MIN"
                    ),
                    # Opposing-train live delay applied to their timeline.
                    "otherDelayMin": round(their_delay_min, 1),
                    "otherDelayBasis": their_delay_basis,
                    # Occupancy windows for dynamic-feedback recomputation.
                    # Prefixed with _ — stripped before return.
                    "_ourIn": our_in,
                    "_ourOut": our_out,
                    "_theirIn": their_in,
                    "_theirOut": their_out,
                })

    conflicts.sort(key=lambda c: c["meetKm"])
    # Drawable = has coordinates from EITHER basis.  Counting only
    # "interpolated" here understated it the moment the shared-polyline
    # fallback landed, which would have read as the fallback not working.
    mappable = sum(1 for c in conflicts
                   if c["meetCoordsBasis"] != "unavailable")

    # How far the delay has moved each meet point.  This is the predictive
    # payload (C6) and it is computed HERE, not in the UI: it needs a second
    # full run at zero delay, and a client differencing two payloads would be
    # doing conflict arithmetic of its own — the thing the tunnel layer's design
    # deliberately avoids.  Cost is one extra local pass over cached JSON; there
    # is no upstream request behind it.
    if delay_min and _with_baseline:
        base = find_conflicts(our_number, 0.0, offsets, others,
                              service_date=service_date, _with_baseline=False,
                              other_delays=other_delays,
                              use_live_delays=use_live_delays,
                              dynamic_feedback=False)
        by_key = {(c["otherTrain"], c["instanceOffsetDays"]): c
                  for c in base["conflicts"]}
        for c in conflicts:
            b = by_key.get((c["otherTrain"], c["instanceOffsetDays"]))
            # A meet with no on-time counterpart is one the delay CREATED
            # (every overtake is of this kind — C10), not one it moved.
            c["scheduledMeetKm"] = b["meetKm"] if b else None
            c["shiftKm"] = round(c["meetKm"] - b["meetKm"], 1) if b else None
            c["existsOnTime"] = b is not None
            c["scheduledWaitMin"] = b["rawWaitMin"] if b else 0.0
            _charge_hold(c, c["rawWaitMin"] - c["scheduledWaitMin"])
    else:
        # On the booked timetable every crossing is already planned and its wait
        # is already inside the scheduled block times — 16345 is paced at
        # 23.6 km/h from SGR to UKC precisely because a crossing sits in there.
        # Charging it again on top of a schedule-derived running time would
        # double-count it, so at zero delay this layer contributes exactly 0.
        # That is the same structural result VERIFIED #19 records for overtakes,
        # and it doubles as the layer's own wiring check: a non-zero total here
        # means the model is inventing conflicts the timetable does not have.
        for c in conflicts:
            c["scheduledMeetKm"] = c["meetKm"]
            c["shiftKm"] = 0.0
            c["existsOnTime"] = True
            c["scheduledWaitMin"] = c["rawWaitMin"]
            _charge_hold(c, 0.0)

    # Three distinct reasons a train shows no crossings, and only one of them
    # is a prediction.  `corridorEligible` answers "can this train have a
    # crossing located at all"; it does not answer "was there anything to
    # cross".  The 8 trains that reach here — Goa Express 12779/12780 (routes
    # via Londa) and the six Vasco-Kulem branch passengers 56961-56966 — are
    # real corridor trains with 3 single-line stations over 7.6 km, and every
    # one of the 209 counterparts fails MIN_SHARED_SPAN_KM against them.  An
    # empty list with no reason reads as "no crossings predicted", which is a
    # far stronger claim than "none could be computed" (VERIFIED #9).
    used_any = any(r["used"] for r in considered)
    unavailable_reason = ineligible_reason
    if unavailable_reason is None and eligible and not used_any:
        unavailable_reason = "no-overlapping-corridor-train"
    unavailable_note = None
    if unavailable_reason == "no-overlapping-corridor-train":
        unavailable_note = (
            f"Train {our_number} runs on the Konkan single-line section but "
            f"shares less than {MIN_SHARED_SPAN_KM:.0f} km of it with any of "
            f"the {len(considered)} other corridor trains, so no crossing "
            f"could be computed. This is NOT a prediction of zero crossings."
        )
    elif unavailable_reason is not None:
        unavailable_note = (
            f"Train {our_number} places {len(our_single_line)} station(s) on "
            f"the Konkan single-line section; at least "
            f"{MIN_SINGLE_LINE_STATIONS} are needed to locate a crossing. "
            f"This is NOT a prediction of zero crossings — none could be "
            f"computed."
        )
    # --- Dynamic feedback loop: cascading hold accumulation -----------------
    # A hold at station K shifts our arrival at every downstream station K'>K
    # by +hold minutes.  Because a train travels monotonically in one spatial
    # direction, there are zero circular dependencies and a single forward
    # sweep resolves the entire cascade in O(N).  The sweep runs AFTER the
    # baseline pass so it uses the already-netted `ourHoldMin` values.
    total_cascading = 0.0
    total_ripple = 0.0
    if dynamic_feedback and conflicts:
        cascading = 0.0
        for c in conflicts:                     # sorted by meetKm
            c["cascadingHoldUpstreamMin"] = round(cascading, 1)
            if cascading > 0:
                # Recompute raw_wait with shifted our-occupancy window.
                new_our_in = c["_ourIn"] + cascading
                new_our_out = c["_ourOut"] + cascading
                new_raw = max(0.0, min(new_our_out, c["_theirOut"])
                              - max(new_our_in, c["_theirIn"]))
                c["rawWaitMin"] = round(new_raw, 1)
                # Recharge hold with the updated raw_wait.
                scheduled = c.get("scheduledWaitMin", 0.0)
                _charge_hold(c, new_raw - scheduled)

            if c["whoIsHeld"] == "us" and c["ourHoldMin"] > 0:
                cascading += c["ourHoldMin"]

            # Ripple: when the opposing train yields, their hold is a delay
            # penalty visible to dispatch.
            c["rippleDelayMin"] = (
                round(c["theirHoldMin"], 1)
                if c["whoIsHeld"] == "them" and c["theirHoldMin"] > 0
                else 0.0
            )
            c["totalCascadingMin"] = round(cascading, 1)

        total_cascading = round(cascading, 1)
        total_ripple = round(
            sum(c["rippleDelayMin"] for c in conflicts), 1)

    # Strip internal occupancy fields — they served the feedback sweep and
    # must not leak into the API contract.
    for c in conflicts:
        for k in ("_ourIn", "_ourOut", "_theirIn", "_theirOut"):
            c.pop(k, None)

    our_total = round(sum(c["ourHoldMin"] for c in conflicts), 1)
    by_conf = {k: sum(1 for c in conflicts if c["locationConfidence"] == k)
               for k in ("fine", "moderate", "coarse")}

    return {
        "train": str(our_number),
        "trainName": us.get("name"),
        "trainType": us.get("type"),
        "trainTypeNormalised": our_label,
        "ourPriority": our_rank,
        "delayMinApplied": delay_min,
        "conflicts": conflicts,
        "totalHoldMin": our_total,
        "totalCascadingHoldMin": total_cascading,
        "totalRippleDelayMin": total_ripple,
        "heldCount": sum(1 for c in conflicts if c["whoIsHeld"] == "us"),
        "precedenceCount": sum(1 for c in conflicts if c["whoIsHeld"] == "them"),
        "mappableCount": mappable,
        "locationConfidenceCounts": by_conf,
        "coarseNote": (
            None if not by_conf["coarse"] else
            f"{by_conf['coarse']} of {len(conflicts)} meets are located across an "
            f"anchor gap wider than {ANCHOR_GAP_MODERATE_KM:.0f} km. Those "
            f"crossings are real — two timetables do cross — but the km and clock "
            f"are approximate, because the other train's schedule is known only at "
            f"the stations it shares with ours."
        ),
        # Summarises the per-meet `meetCoordsBasis` values actually present, so
        # a run resolved off the shared alignment never reports itself as having
        # used this train's own station rows.
        "coordsBasis": (
            "unavailable" if not mappable
            else "partial" if mappable < len(conflicts)
            else "+".join(sorted({c["meetCoordsBasis"] for c in conflicts}))
        ),
        "coordsNote": (
            None if not conflicts or mappable == len(conflicts) else
            f"{len(conflicts) - mappable} of {len(conflicts)} meet points have no "
            f"lat/lng: train {our_number} was cached without includeCoordinates "
            f"and the meet km falls outside the cached corridor polyline "
            f"(no geometry south of MAO yet), so they cannot be drawn on the "
            f"map. The km and times are unaffected."
        ),
        "_meta": {
            "serviceDate": service_date.isoformat() if service_date else None,
            "runDayFilter": (
                "applied" if service_date else "none - every roster train counted"
            ),
            "runDayNote": (
                "Only 59 of the 206 roster trains run daily; 88 run one day a "
                "week. Without a service date every train is counted, which "
                "roughly doubles the traffic actually on the corridor. Trains "
                "with no calendar (the corridor-cache files) are always counted "
                "and carry runDayBasis 'no-calendar'."
            ),
            "instancesSkippedNotRunning": skipped_not_running,
            "ourTrainRunDays": us.get("run_days"),
            "ourTrainRunsOnDate": we_run,
            "ourTrainRunDayBasis": our_run_basis,
            "ourTrainRunDayNote": (
                None if we_run else
                f"Train {our_number} is not booked to run on "
                f"{service_date.isoformat() if service_date else 'this date'} "
                f"(runs {us.get('run_days')}). The crossings below are for a "
                f"hypothetical service on that date, not a scheduled one."
            ),
            "singleLineBasis": section_basis,
            "singleLineNote": section_note,
            "singleLineStations": len(our_single_line),
            "corridorEligible": eligible,
            "corridorIneligibleReason": ineligible_reason,
            "corridorIneligibleNote": unavailable_note if not eligible else None,
            # What the UI should render instead of an empty panel.  None means
            # the layer ran and the answer is genuinely "no crossings".
            "crossingsUnavailableReason": unavailable_reason,
            "crossingsUnavailableNote": unavailable_note,
            "usableCounterparts": sum(1 for r in considered if r["used"]),
            "corridorCoverage": our_coverage,
            "sectionNote": (
                "CSMT->Roha is Central Railway double line; a meet there needs "
                "no hold and is excluded. Konkan Railway Roha->Thokur is single line."
            ),
            "loopBasis": "assumed-all-stations",
            "loopDataIsOfficial": False,
            "loopNote": (
                "Every timetable station on the single-line section is assumed "
                "able to hold a crossing. This source carries NO loop or "
                "track-count data — the locations are an assumption, not a source."
            ),
            "priorityBasis": "heuristic-over-train-type",
            "priorityIsOfficial": False,
            "priorityNote": (
                "Ladder derived from the train 'type' string, not official "
                "Indian Railways precedence rules. Real precedence is a Section "
                "Controller's decision and may differ."
            ),
            "priorityLadder": [
                {"rank": r, "label": l} for l, r, _ in
                sorted({(lbl, rk, pat) for pat, rk, lbl in PRIORITY_RULES},
                       key=lambda x: (x[1], x[0]))
            ],
            "reaccelMin": REACCEL_MIN,
            "reaccelNote": "Assumed restart cost from a dead stand in a loop; not measured.",
            "delayModel": "carried-forward (our delay applied uniformly, no recovery assumed)",
            "otherTrainsAreScheduled": not bool(other_delays_applied),
            "otherTrainsNote": (
                "Other trains' times are SCHEDULED, not live. Only our own delay "
                "is live. No upstream request is made for any other train."
                if not other_delays_applied else
                f"Live delays applied to {len(other_delays_applied)} counterpart "
                f"train(s) from cached dated runs. Remaining trains are scheduled."
            ),
            "dynamicFeedback": bool(dynamic_feedback),
            "useLiveDelays": bool(use_live_delays),
            "otherDelaysApplied": other_delays_applied or None,
            "totalCascadingHoldMin": total_cascading,
            "totalRippleDelayMin": total_ripple,
            "offsetsScanned": sorted(offsets_seen),
            "offsetsBasis": "derived-per-pair" if offsets_auto else "explicit",
            "ourCorridorDays": (list(our_corridor_days)
                                if our_corridor_days else None),
            "offsetsNote": (
                "A multi-day train's instance on our corridor today may have "
                "departed days earlier OR later, so the departure-day offset "
                "window is derived per pair from both trains' corridor "
                "occupancy days rather than fixed. The offsets actually "
                "scanned for each counterpart are on its trainsConsidered row."
            ),
            "decisionSupportOnly": True,
            "controlNote": (
                "Prediction for a human Section Controller to confirm. No "
                "automated control, dispatch or signalling action."
            ),
            "trainsConsidered": considered,
        },
    }


# --- corridor-wide sweep -----------------------------------------------------
#
# The per-train view answers "where does THIS train meet others".  This answers
# "where does anything meet anything" for a whole service date.
#
# It costs zero additional upstream requests — every meet falls out of two static
# timetables (VERIFIED #15) — but it must never imply we have live positions for
# the roster.  We have live position for exactly ONE train (FLEET_TRAINS=12051,
# FLEET_MAX_TRAINS=1; live is never cached, so fleet size IS the per-poll request
# count against a 10 req/min ceiling).  So every row is labelled
# `positionBasis: "scheduled"` and the aggregate carries `liveTrains`.
#
# Deduplication is by unordered pair + rounded corridor km + wall clock, NOT by
# the day-normalised minute.  A meet computed from A's axis and from B's axis is
# one physical event, but the two views may reach it at different journey-day
# offsets (A sees B at offset -1 while B sees A at +1), so the absolute minute
# differs by 1440 while `meetClock` agrees.  Keying on the minute would emit the
# same meet twice and inflate the corridor count.

_corridor_sweep_cache = {}


def corridor_conflicts(service_date=None, delay_min=0.0, roster=None,
                       at_clock=None, window_min=60, use_cache=True,
                       use_live_delays=False, dynamic_feedback=False):
    """Every predicted meet on the corridor for one service date, deduplicated.

    `delay_min` is applied to EVERY train, so the default 0.0 is the booked
    timetable — which is conflict-free by construction for holds (VERIFIED #19)
    but still full of *crossings*.  The crossings are the point here; the holds
    are legitimately 0.0 and reported as such.

    `at_clock` ("HH:MM") keeps only meets within +/- `window_min` of that wall
    clock, for a "what is crossing right now" view.
    """
    # Normalise BEFORE the cache key, not after.  `find_conflicts` parses its
    # own date, so a caller passing "2026-09-11" and one passing
    # `date(2026, 9, 11)` produce identical results but two different keys —
    # two full 206-train sweeps for one answer.  Normalising here also keeps
    # `serviceDate` JSON-serialisable: a bare `date` object 500s the endpoint,
    # which the CLI never hit because argparse hands it a string.
    service_date = _parse_date(service_date)
    key = (service_date, delay_min, at_clock, window_min,
           tuple(roster) if roster else None,
           use_live_delays, dynamic_feedback)
    if use_cache and key in _corridor_sweep_cache:
        return _corridor_sweep_cache[key]

    trains = list(roster) if roster else sorted(_load_full_dataset().keys())

    meets, per_train, failed = {}, [], []
    dup_hits = no_axis = 0
    for n in trains:
        try:
            r = find_conflicts(n, delay_min, service_date=service_date,
                              use_live_delays=use_live_delays,
                              dynamic_feedback=dynamic_feedback)
        except Exception as e:                                   # noqa: BLE001
            failed.append({"train": str(n), "error": f"{type(e).__name__}: {e}"})
            continue
        m = r["_meta"]
        per_train.append({
            "train": r["train"], "name": r["trainName"],
            "type": r["trainTypeNormalised"], "priority": r["ourPriority"],
            "crossings": len(r["conflicts"]),
            "unavailableReason": m["crossingsUnavailableReason"],
            "runsOnDate": m["ourTrainRunsOnDate"],
        })
        for c in r["conflicts"]:
            pair = tuple(sorted((r["train"], c["otherTrain"])))
            ckm = c["meetCorridorKm"]
            # Key on the WALL-CLOCK minute, never on `meetClock` or the
            # day-normalised minute.  `meetClock` carries a '+1d' suffix and
            # the two views of one meet routinely sit on different journey
            # days — 11003/09021 is '02:22' from one axis and '02:22 +1d' from
            # the other, same corridor km, same held train.  String-keying
            # emitted both and inflated the corridor count.
            clock_min = round(c["meetTimeMin"]) % 1440
            if ckm is None:
                # No canonical km — the bracketing stations are off the corridor
                # axis.  `meetKm` is on OUR OWN axis and therefore differs
                # between the two views of the same meet, so it cannot be part
                # of the key.  Fall back to pair + clock, and count these
                # separately: dedup is weaker here and saying so is cheaper than
                # a silently doubled row.
                k = (pair, None, clock_min)
                no_axis += 1
            else:
                k = (pair, round(ckm, 0), clock_min)
            if k in meets:
                dup_hits += 1
                _merge_view(meets, k, _corridor_meet_row(r, c))
                continue
            meets[k] = _corridor_meet_row(r, c)

    # Pass 2: tolerance merge.  The exact key above cannot catch the case where
    # both views interpolate the same meet across a wide anchor gap and land a
    # few km and a few minutes apart (11003/11099: 04:12 @ km 78.8 vs 04:16 @
    # km 82.9, both `coarse`, anchor gap 111 km).  Those are one meet.
    rows, tol_merged = _tolerance_merge(list(meets.values()))

    # corridorKm is None for meets whose bracketing stations are off the
    # canonical axis, so it cannot be a bare sort key.  Sort those last rather
    # than dropping them: the meet is real, only its corridor position is
    # unknown, and the row says so via corridorKm: null.
    rows.sort(key=lambda x: (x["timeMin"],
                             x["corridorKm"] if x["corridorKm"] is not None
                             else float("inf")))

    filtered_out = 0
    if at_clock:
        want = _hhmm_to_min(at_clock)
        if want is not None:
            keep = []
            for x in rows:
                # Compare on the wall clock, wrapped, so a window straddling
                # midnight still matches.
                d = abs((x["timeMin"] % 1440) - want)
                if min(d, 1440 - d) <= window_min:
                    keep.append(x)
            filtered_out = len(rows) - len(keep)
            rows = keep

    out = {
        "serviceDate": service_date.isoformat() if service_date else None,
        "delayMinAppliedToEveryTrain": delay_min,
        "atClock": at_clock,
        "windowMin": window_min if at_clock else None,
        "meets": rows,
        "meetCount": len(rows),
        "trainsSwept": len(per_train),
        "trainsFailed": failed,
        "trainsWithCrossings": sum(1 for t in per_train if t["crossings"]),
        "trainsUnavailable": sum(1 for t in per_train if t["unavailableReason"]),
        "perTrain": per_train,
        "duplicateViewsMerged": dup_hits,
        "duplicateViewsMergedByTolerance": tol_merged,
        "meetsWithoutCanonicalKm": no_axis,
        "filteredOutByClock": filtered_out,
        "locationConfidenceCounts": {
            k: sum(1 for x in rows if x["locationConfidence"] == k)
            for k in ("fine", "moderate", "coarse")
        },
        "kindCounts": {
            k: sum(1 for x in rows if x["kind"] == k)
            for k in ("opposing", "overtake")
        },
        # --- honesty block; see the module comment above -----------------
        "positionBasis": "scheduled",
        "liveTrains": 0,
        "positionNote": (
            "Every meet on this layer is computed from two SCHEDULED timetables. "
            "No train here carries a live GPS position — the live fleet is one "
            "train, shown separately. A marker is where two timetables cross, "
            "not where two trains are."
        ),
        "loopBasis": "assumed-all-stations",
        "loopDataIsOfficial": False,
        "priorityBasis": "heuristic-over-train-type",
        "priorityIsOfficial": False,
        "otherTrainsAreScheduled": True,
        "decisionSupportOnly": True,
        "dedupNote": (
            f"{dup_hits + tol_merged} meets were seen from both trains' axes and "
            f"merged into one row, keeping the better-located view: "
            f"{dup_hits} on an exact key (unordered pair + corridor km + "
            f"wall-clock minute, never the day-normalised minute or the clock "
            f"string, which carries a '+1d' suffix) and {tol_merged} more within "
            f"a tolerance derived from each pair's own anchor gap."
        ),
    }
    if use_cache:
        _corridor_sweep_cache[key] = out
    return out


_CONF_RANK = {"fine": 0, "moderate": 1, "coarse": 2}


def _merge_view(store, key, new_row):
    """Fold a second view of one meet into the stored row.

    Keeps the FINER-located of the two rather than whichever arrived first: the
    two trains have different anchor densities on the shared corridor, so one
    view is often materially better located than the other.
    """
    old = store[key]
    views = old.get("viewCount", 1) + 1
    if _CONF_RANK[new_row["locationConfidence"]] < _CONF_RANK[old["locationConfidence"]]:
        store[key] = new_row
    store[key]["viewCount"] = views
    # Both views are kept as provenance so a disagreement is inspectable rather
    # than silently resolved.
    store[key].setdefault("mergedViews", []).append(
        {"from": old["trainA"], "corridorKm": old["corridorKm"],
         "clock": old["clock"], "locationConfidence": old["locationConfidence"]}
    )
    return store[key]


def _tolerance_merge(rows):
    """Merge same-pair, same-kind rows that are one meet seen twice.

    The km tolerance is derived per pair from `anchorMaxGapKm` — the measured
    location uncertainty — rather than fixed, so a tightly-anchored pair is held
    to a tight tolerance and only a loosely-anchored one is given slack.
    """
    groups = {}
    for x in rows:
        groups.setdefault(
            (tuple(sorted((x["trainA"], x["trainB"]))), x["kind"]), []
        ).append(x)

    out, merged = [], 0
    for _k, grp in groups.items():
        if len(grp) == 1:
            out.append(grp[0])
            continue
        grp.sort(key=lambda x: x["timeMin"] % 1440)
        kept = []
        for x in grp:
            hit = None
            for y in kept:
                # The journey-day guard.  Pass 1 keys on minute-of-day on
                # purpose: a daily pair meeting at the SAME km and the SAME
                # minute on consecutive days is one entry in a daily corridor
                # picture.  Pass 2's window is fuzzy, so it must not bridge two
                # genuinely different meets that happen to fall near the same
                # minute-of-day several days apart.  06904/22654 is the case:
                # journey days 1 and 4, 4.8 km and 37 min apart — it survived
                # only because 37 > 30, which is luck, not a rule.
                if abs(x["timeMin"] // 1440 - y["timeMin"] // 1440) > 1:
                    continue
                dt = abs((x["timeMin"] % 1440) - (y["timeMin"] % 1440))
                dt = min(dt, 1440 - dt)
                if dt > CORRIDOR_DEDUP_MIN:
                    continue
                if x["corridorKm"] is None or y["corridorKm"] is None:
                    hit = y
                    break
                gap = max(x.get("anchorMaxGapKm") or 0.0,
                          y.get("anchorMaxGapKm") or 0.0)
                tol = max(CORRIDOR_DEDUP_KM_FLOOR,
                          CORRIDOR_DEDUP_GAP_FRACTION * gap)
                if abs(x["corridorKm"] - y["corridorKm"]) <= tol:
                    hit = y
                    break
            if hit is None:
                kept.append(x)
            else:
                merged += 1
                idx = kept.index(hit)
                store = {0: hit}
                _merge_view(store, 0, x)
                kept[idx] = store[0]
        out.extend(kept)
    return out, merged


def _corridor_meet_row(result, c):
    """One deduplicated corridor meet, flattened for the map layer."""
    return {
        "trainA": result["train"], "trainAName": result["trainName"],
        "trainAType": result["trainTypeNormalised"],
        "trainB": c["otherTrain"], "trainBName": c["otherName"],
        "trainBType": c["otherType"],
        "kind": c["kind"],
        "km": c["meetKm"],
        "corridorKm": c["meetCorridorKm"],
        "timeMin": c["meetTimeMin"],
        "clock": c["meetClock"],
        "lat": c["meetLat"], "lng": c["meetLng"],
        "coordsBasis": c["meetCoordsBasis"],
        "betweenFrom": c["betweenFrom"], "betweenTo": c["betweenTo"],
        "isSingleLine": c["isSingleLine"],
        "whoIsHeld": c["whoIsHeld"],
        "heldTrain": (result["train"] if c["whoIsHeld"] == "us"
                      else c["otherTrain"] if c["whoIsHeld"] == "them" else None),
        "holdStation": c["holdStation"],
        "holdMin": (c["ourHoldMin"] if c["whoIsHeld"] == "us" else c["theirHoldMin"]),
        "existsOnTime": c["existsOnTime"],
        "locationConfidence": c["locationConfidence"],
        "anchorMaxGapKm": c["anchorMaxGapKm"],
        "instanceOffsetDays": c["instanceOffsetDays"],
        "viewCount": 1,
        # Repeated per row, not only in the header, because a single marker's
        # tooltip is read without the header in view.
        "positionBasis": "scheduled",
    }


# --- CLI ---------------------------------------------------------------------

def _main_corridor(args):
    """--corridor: the whole-roster sweep, with every intermediate count."""
    res = corridor_conflicts(service_date=args.date, delay_min=args.delay,
                             at_clock=args.at, window_min=args.window)
    if args.json:
        print(json.dumps(res, indent=2))
        return 0

    print(f"=== corridor-wide crossings  {res['serviceDate'] or '(no service date)'} ===")
    print(f"trains swept          : {res['trainsSwept']}"
          + (f"  ({len(res['trainsFailed'])} failed)" if res["trainsFailed"] else ""))
    print(f"  with >=1 crossing   : {res['trainsWithCrossings']}")
    print(f"  labelled unavailable: {res['trainsUnavailable']}")
    print(f"delay applied to all  : +{res['delayMinAppliedToEveryTrain']:.0f} min")
    print(f"unique meets          : {res['meetCount']}"
          f"   (merged {res['duplicateViewsMerged']} second views on the exact key"
          f" + {res['duplicateViewsMergedByTolerance']} within tolerance)")
    print(f"  no canonical km     : {res['meetsWithoutCanonicalKm']}"
          f"  (dedup is weaker for these — pair+clock only)")
    if res["atClock"]:
        print(f"clock filter          : {res['atClock']} +/-{res['windowMin']} min"
              f"  ({res['filteredOutByClock']} dropped)")
    print(f"kinds                 : {res['kindCounts']}")
    print(f"location confidence   : {res['locationConfidenceCounts']}")
    print(f"position basis        : {res['positionBasis']}  "
          f"(live trains on this layer: {res['liveTrains']})")
    print(f"  {res['positionNote']}")
    print()
    print(f"{'clock':>6}  {'corrKm':>7}  {'pair':<14} {'kind':<9} "
          f"{'held':<7} {'conf':<9} between")
    for x in res["meets"][:60]:
        ckm = "     -" if x["corridorKm"] is None else f"{x['corridorKm']:>7.1f}"
        print(f"{x['clock']:>6}  {ckm:>7}  "
              f"{x['trainA'] + '/' + x['trainB']:<14} {x['kind']:<9} "
              f"{str(x['heldTrain'] or '-'):<7} {x['locationConfidence']:<9} "
              f"{x['betweenFrom']}->{x['betweenTo']}")
    if len(res["meets"]) > 60:
        print(f"  ... and {len(res['meets']) - 60} more")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--train", default="12051")
    ap.add_argument("--delay", type=float, default=0.0,
                    help="our train's delay in minutes (carried forward)")
    ap.add_argument("--offsets", default=AUTO_OFFSETS,
                    help="'auto' (default, derived per pair) or e.g. '0,-1,-2'")
    ap.add_argument("--date", default=None,
                    help="service date YYYY-MM-DD; filters candidates by run_days. "
                         "Omit to count every roster train (loudly flagged).")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--corridor", action="store_true",
                    help="sweep the WHOLE roster instead of one train and print "
                         "every deduplicated meet on the corridor")
    ap.add_argument("--at", default=None,
                    help="with --corridor: keep only meets within --window of "
                         "this wall clock, e.g. 14:30")
    ap.add_argument("--window", type=int, default=60,
                    help="with --at: half-width in minutes (default 60)")
    args = ap.parse_args()

    if args.corridor:
        return _main_corridor(args)

    offsets = (AUTO_OFFSETS if args.offsets.strip().lower() == AUTO_OFFSETS
               else tuple(int(o) for o in args.offsets.split(",") if o.strip()))
    result = find_conflicts(args.train, args.delay, offsets,
                            service_date=args.date)

    if args.json:
        print(json.dumps(result, indent=2))
        return 0

    m = result["_meta"]
    print(f"=== {result['train']} {result['trainName']} "
          f"[{result['trainTypeNormalised']}, priority {result['ourPriority']}] ===")
    print(f"Delay applied: +{result['delayMinApplied']:.0f} min ({m['delayModel']})")
    cov = m["corridorCoverage"]
    print(f"Single-line stations: {m['singleLineStations']}  "
          f"[{m['singleLineBasis']}]  "
          f"corridor {cov['onAxis']}/{cov['stations']} on axis"
          + (f", {cov['offAxis']} off-corridor" if cov["offAxis"] else ""))
    if m["crossingsUnavailableReason"]:
        print(f"\n  ** {m['crossingsUnavailableReason']}: "
              f"{m['crossingsUnavailableNote']}")
    print(f"Offsets scanned: {m['offsetsScanned']}  [{m['offsetsBasis']}]"
          + (f"  our corridor days {m['ourCorridorDays']}"
             if m["ourCorridorDays"] else ""))
    print(f"Service date: {m['serviceDate'] or '(none)'}  "
          f"run-day filter: {m['runDayFilter']}  "
          f"instances skipped: {m['instancesSkippedNotRunning']}")
    print()

    used = [t for t in m["trainsConsidered"] if t["used"]]
    print(f"Corridor trains considered: {len(m['trainsConsidered'])}, "
          f"used: {len(used)}")
    for t in m["trainsConsidered"]:
        mark = "  use " if t["used"] else "  skip"
        print(f"{mark} {t['train']:<7} shared {t['shared']:>3} "
              f"(in-section {t['sharedInSection']:>3}, span {t['sharedSpanKm']:>6.1f} km)"
              + ("" if t["used"] else f"  — {t['reason']}"))
    print()

    if not result["conflicts"]:
        if m["crossingsUnavailableReason"]:
            print("No crossings COMPUTED — see the note above. "
                  "This is not the same as 'no crossings'.")
            return 0
        print("No crossings or overtakes predicted.")
        return 0

    print(f"{'km':>7} {'time':>9} {'kind':<9} {'vs':<7} {'their type':<14}"
          f"{'section':<14}{'held':<6}{'hold':>7}  {'loc':<9} off")
    print("-" * 106)
    for c in result["conflicts"]:
        held = {"us": "US", "them": "them", "none": "-"}[c["whoIsHeld"]]
        hold = c["ourHoldMin"] if c["whoIsHeld"] == "us" else c["theirHoldMin"]
        print(f"{c['meetKm']:>7.1f} {c['meetClock']:>9} {c['kind']:<9} "
              f"{c['otherTrain']:<7} {c['otherType']:<14}"
              f"{c['betweenFrom'] + '-' + c['betweenTo']:<14}{held:<6}"
              f"{hold:>6.1f}m  {c['locationConfidence']:<9} "
              f"{c['instanceOffsetDays']:>+d}")
    print("-" * 106)
    print(f"Our total hold: {result['totalHoldMin']:.1f} min "
          f"({result['heldCount']} held, {result['precedenceCount']} we take precedence)")
    lc = result["locationConfidenceCounts"]
    print(f"Meet location: {lc['fine']} fine, {lc['moderate']} moderate, "
          f"{lc['coarse']} coarse")
    if result["coarseNote"]:
        print(f"  {result['coarseNote']}")
    print()
    print(f"ASSUMED: loop locations ({m['loopBasis']}); priority ladder "
          f"({m['priorityBasis']}); reaccel {m['reaccelMin']} min.")
    print("Other trains' times are SCHEDULED. Decision support only — "
          "no automated control.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
