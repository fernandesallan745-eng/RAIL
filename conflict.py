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
import os, sys, json, glob, argparse

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

# A train must share this much of the single-line section before a crossing with
# it is meaningful.  Goa Express (12779/12780) joins the route only at Madgaon
# and shares 3 stations — excluded here on physical grounds, not by a magic count.
MIN_SHARED_IN_SECTION = 4
MIN_SHARED_SPAN_KM = 25.0

# A train's journey can span several days, so the instance occupying our
# corridor today may have departed 1-2 days ago.  Scanning only offset 0 finds
# 2 of 12051's 5 crossings.
DEFAULT_OFFSETS = (0, -1, -2)

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
    stations are absent.  That is fine: the conflict walk only needs enough shared
    stations to bracket a sign flip, and every halt on the single-line section is
    included.
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
            return json.load(f)

    full = _load_full_dataset()
    record = full.get(str(number))
    if record is not None:
        return adapt_full_dataset_train(record)

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

    Found by station code rather than a constant so it holds for both
    directions: Roha sits at km 142.2 on a down train and km 440.0 on an up
    train.  Taking the sorted span between the Roha and Madgaon anchors is
    direction-agnostic.
    """
    km = {s["code"]: s["km"] for s in train["stations"]}
    roha, mao = km.get(SECTION_ANCHORS[0]), km.get(SECTION_ANCHORS[1])
    if roha is not None and mao is not None:
        lo, hi = sorted((roha, mao))
        return lo, hi, "anchored:ROHA-MAO"
    if roha is not None:
        # Only one anchor: assume single line runs from Roha to the far end.
        far = max(s["km"] for s in train["stations"])
        lo, hi = sorted((roha, far))
        return lo, hi, "anchored:ROHA-only"
    return ROHA_FALLBACK_KM, max(s["km"] for s in train["stations"]), "fallback-km"


# --- Core --------------------------------------------------------------------

def _interp(a, b, f):
    if a is None or b is None:
        return None
    return a + f * (b - a)


def _clock(minutes):
    """Day-normalised minutes -> 'HH:MM' (+1d marker for a later journey day)."""
    if minutes is None:
        return None
    day, mod = divmod(int(round(minutes)), 1440)
    return f"{mod // 60:02d}:{mod % 60:02d}" + (f" +{day}d" if day else "")


def find_conflicts(our_number, delay_min=0.0, offsets=DEFAULT_OFFSETS,
                   others=None, _with_baseline=True):
    """Predict every crossing / overtake for one run of `our_number`.

    `delay_min` is applied uniformly to our whole journey — i.e. the delay is
    assumed to be *carried*, not recovered.  That is deliberately pessimistic
    and is stated in the payload as `delayModel`.
    """
    us = load_corridor_train(our_number)
    our_label, our_rank = normalise_type(us.get("type"))
    lo_km, hi_km, section_basis = single_line_span(us)

    our_st = {s["code"]: s for s in us["stations"]}
    candidates = others if others is not None else list_corridor_trains()

    conflicts, considered = [], []

    for other_number in candidates:
        if str(other_number) == str(our_number):
            continue
        try:
            them = load_corridor_train(other_number)
        except FileNotFoundError:
            continue

        their_st = {s["code"]: s for s in them["stations"]}
        shared_codes = [c for c in our_st if c in their_st]

        # Restrict to the single-line section: a meet on double track needs no
        # hold, so shared stations outside it cannot produce a conflict.
        in_section = [c for c in shared_codes if lo_km <= our_st[c]["km"] <= hi_km]
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
        walk = sorted(in_section, key=lambda c: our_st[c]["km"])
        walk = [c for c in walk if station_time(our_st[c]) is not None
                and station_time(their_st[c]) is not None]
        if len(walk) < 2:
            continue

        # Same direction or opposing?  Their own chainage either rises or falls
        # as we advance.  Offset-independent, so it is decided once.
        their_km_first, their_km_last = their_st[walk[0]]["km"], their_st[walk[-1]]["km"]
        same_direction = their_km_last > their_km_first
        kind = "overtake" if same_direction else "opposing"

        their_label, their_rank = normalise_type(them.get("type"))

        for off in offsets:
            shift = off * 1440
            gaps = []
            for c in walk:
                ours = station_time(our_st[c]) + delay_min
                theirs = station_time(their_st[c]) + shift
                gaps.append(ours - theirs)

            for i in range(len(walk) - 1):
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
                a, b = our_st[walk[i]], our_st[walk[i + 1]]
                meet_km = _interp(a["km"], b["km"], f)
                meet_t = _interp(station_time(a) + delay_min,
                                 station_time(b) + delay_min, f)

                # Who yields.
                our_t_a = station_time(a) + delay_min
                their_t_a = station_time(their_st[walk[i]]) + shift
                our_t_b = station_time(b) + delay_min
                their_t_b = station_time(their_st[walk[i + 1]]) + shift

                our_hold = their_hold = 0.0
                hold_station = None
                overtaker = None
                precedence_note = None

                if same_direction:
                    # An overtake is physically forced: the train being PASSED
                    # takes the loop, whatever the ladder says — you cannot pass
                    # on single line otherwise.  The flip direction says who
                    # passes whom, and getting this backwards produces a hold of
                    # exactly REACCEL_MIN with a zero wait, which is impossible.
                    #   gap + -> - : we were behind at A, ahead at B -> we pass
                    #   gap - -> + : they pass us
                    if g0 > 0:
                        overtaker, who = str(our_number), "them"
                        their_hold = max(0.0, our_t_a - their_t_a) + REACCEL_MIN
                    else:
                        overtaker, who = str(other_number), "us"
                        our_hold = max(0.0, their_t_a - our_t_a) + REACCEL_MIN
                    hold_station = walk[i]
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
                    # Head-on: the lower-ranked train waits at its own entry to
                    # the section until the other has cleared.  We enter at A,
                    # an opposing train enters at B.  Equal rank: later arrival yields.
                    if our_rank < their_rank:
                        who = "them"
                    elif our_rank > their_rank:
                        who = "us"
                    else:
                        who = "us" if our_t_a > their_t_b else "them"

                    if who == "us":
                        our_hold = max(0.0, their_t_a - our_t_a) + REACCEL_MIN
                        hold_station = walk[i]
                    else:
                        their_hold = max(0.0, our_t_b - their_t_b) + REACCEL_MIN
                        hold_station = walk[i + 1]

                meet_lat = _interp(a.get("lat"), b.get("lat"), f)
                meet_lng = _interp(a.get("lng"), b.get("lng"), f)

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
                    "meetTimeMin": round(meet_t, 1),
                    "meetClock": _clock(meet_t),
                    "meetLat": meet_lat,
                    "meetLng": meet_lng,
                    # Coordinates come from OUR train's station rows, so they are
                    # present only if this train was cached with
                    # includeCoordinates=true (VERIFIED #13).  Flagged rather
                    # than silently null so the map can say why a marker is
                    # missing instead of just not drawing it.
                    "meetCoordsBasis": ("interpolated" if meet_lat is not None
                                        and meet_lng is not None else "unavailable"),
                    "betweenFrom": walk[i],
                    "betweenFromName": a.get("name"),
                    "betweenTo": walk[i + 1],
                    "betweenToName": b.get("name"),
                    "instanceOffsetDays": off,
                    "isSingleLine": True,
                    "whoIsHeld": who,
                    "overtakingTrain": overtaker,
                    "precedenceNote": precedence_note,
                    "ourHoldMin": round(our_hold, 1),
                    "theirHoldMin": round(their_hold, 1),
                    "holdStation": hold_station,
                    "holdStationName": (our_st[hold_station] or {}).get("name")
                                       if hold_station else None,
                    "holdBasis": (
                        "overtake: the train being passed takes the loop and waits "
                        "for the faster one to clear, plus REACCEL_MIN"
                        if same_direction else
                        "head-on: the lower-priority train waits at its entry to the "
                        "section until the other clears, plus REACCEL_MIN"
                    ),
                })

    conflicts.sort(key=lambda c: c["meetKm"])
    our_total = round(sum(c["ourHoldMin"] for c in conflicts), 1)
    mappable = sum(1 for c in conflicts if c["meetCoordsBasis"] == "interpolated")

    # How far the delay has moved each meet point.  This is the predictive
    # payload (C6) and it is computed HERE, not in the UI: it needs a second
    # full run at zero delay, and a client differencing two payloads would be
    # doing conflict arithmetic of its own — the thing the tunnel layer's design
    # deliberately avoids.  Cost is one extra local pass over cached JSON; there
    # is no upstream request behind it.
    if delay_min and _with_baseline:
        base = find_conflicts(our_number, 0.0, offsets, others,
                              _with_baseline=False)
        by_key = {(c["otherTrain"], c["instanceOffsetDays"]): c
                  for c in base["conflicts"]}
        for c in conflicts:
            b = by_key.get((c["otherTrain"], c["instanceOffsetDays"]))
            # A meet with no on-time counterpart is one the delay CREATED
            # (every overtake is of this kind — C10), not one it moved.
            c["scheduledMeetKm"] = b["meetKm"] if b else None
            c["shiftKm"] = round(c["meetKm"] - b["meetKm"], 1) if b else None
            c["existsOnTime"] = b is not None
    else:
        for c in conflicts:
            c["scheduledMeetKm"] = c["meetKm"]
            c["shiftKm"] = 0.0
            c["existsOnTime"] = True

    return {
        "train": str(our_number),
        "trainName": us.get("name"),
        "trainType": us.get("type"),
        "trainTypeNormalised": our_label,
        "ourPriority": our_rank,
        "delayMinApplied": delay_min,
        "conflicts": conflicts,
        "totalHoldMin": our_total,
        "heldCount": sum(1 for c in conflicts if c["whoIsHeld"] == "us"),
        "precedenceCount": sum(1 for c in conflicts if c["whoIsHeld"] == "them"),
        "mappableCount": mappable,
        "coordsBasis": (
            "interpolated" if conflicts and mappable == len(conflicts)
            else "partial" if mappable else "unavailable"
        ),
        "coordsNote": (
            None if not conflicts or mappable == len(conflicts) else
            f"{len(conflicts) - mappable} of {len(conflicts)} meet points have no "
            f"lat/lng: train {our_number} was cached without includeCoordinates, "
            f"so they cannot be drawn on the map. The km and times are unaffected."
        ),
        "_meta": {
            "singleLineSectionKm": [round(lo_km, 1), round(hi_km, 1)],
            "singleLineBasis": section_basis,
            "singleLineNote": (
                "CSMT->Roha is Central Railway double line; a meet there needs "
                "no hold and is excluded. Konkan Railway Roha->Madgaon is single line."
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
            "otherTrainsAreScheduled": True,
            "otherTrainsNote": (
                "Other trains' times are SCHEDULED, not live. Only our own delay "
                "is live. No upstream request is made for any other train."
            ),
            "offsetsScanned": list(offsets),
            "offsetsNote": (
                "A multi-day train's instance on our corridor today may have "
                "departed 1-2 days ago; scanning only offset 0 misses most crossings."
            ),
            "decisionSupportOnly": True,
            "controlNote": (
                "Prediction for a human Section Controller to confirm. No "
                "automated control, dispatch or signalling action."
            ),
            "trainsConsidered": considered,
        },
    }


# --- CLI ---------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--train", default="12051")
    ap.add_argument("--delay", type=float, default=0.0,
                    help="our train's delay in minutes (carried forward)")
    ap.add_argument("--offsets", default=",".join(str(o) for o in DEFAULT_OFFSETS))
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    offsets = tuple(int(o) for o in args.offsets.split(",") if o.strip())
    result = find_conflicts(args.train, args.delay, offsets)

    if args.json:
        print(json.dumps(result, indent=2))
        return 0

    m = result["_meta"]
    print(f"=== {result['train']} {result['trainName']} "
          f"[{result['trainTypeNormalised']}, priority {result['ourPriority']}] ===")
    print(f"Delay applied: +{result['delayMinApplied']:.0f} min ({m['delayModel']})")
    print(f"Single-line section: km {m['singleLineSectionKm'][0]}"
          f"-{m['singleLineSectionKm'][1]}  [{m['singleLineBasis']}]")
    print(f"Offsets scanned: {m['offsetsScanned']}")
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
        print("No crossings or overtakes predicted.")
        return 0

    print(f"{'km':>7} {'time':>9} {'kind':<9} {'vs':<7} {'their type':<14}"
          f"{'section':<14}{'held':<6}{'hold':>7}  off")
    print("-" * 96)
    for c in result["conflicts"]:
        held = {"us": "US", "them": "them", "none": "-"}[c["whoIsHeld"]]
        hold = c["ourHoldMin"] if c["whoIsHeld"] == "us" else c["theirHoldMin"]
        print(f"{c['meetKm']:>7.1f} {c['meetClock']:>9} {c['kind']:<9} "
              f"{c['otherTrain']:<7} {c['otherType']:<14}"
              f"{c['betweenFrom'] + '-' + c['betweenTo']:<14}{held:<6}"
              f"{hold:>6.1f}m  {c['instanceOffsetDays']:>+d}")
    print("-" * 96)
    print(f"Our total hold: {result['totalHoldMin']:.1f} min "
          f"({result['heldCount']} held, {result['precedenceCount']} we take precedence)")
    print()
    print(f"ASSUMED: loop locations ({m['loopBasis']}); priority ladder "
          f"({m['priorityBasis']}); reaccel {m['reaccelMin']} min.")
    print("Other trains' times are SCHEDULED. Decision support only — "
          "no automated control.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
