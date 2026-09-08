"""
build_konkan_dataset.py — Steps 4-6 of the Konkan corridor dataset build.

OFFLINE. Reads the raw responses fetch_konkan_corridor.py left in
`.cache/corridor_raw/` and merges them into
`.cache/konkan_full_corridor_trains.json`. No network, no quota. Re-run it
freely: every classification decision below can be changed and re-derived
without spending a single request.

    python3 scripts/build_konkan_dataset.py --dry-run
    python3 scripts/build_konkan_dataset.py

WHAT IT PRODUCES, per train: number, name, category, the priority rank the
crossing model will use, `stops_on_corridor`, `through_only`, and the corridor
stations it touches with scheduled times where the station board gave them.

`through_only` is the point of the exercise. A train found ONLY by the
`/trains/between` sweep halts nowhere we looked, yet still occupies the single
line and can still force our train into a loop — and those are typically the
highest-priority services on the section, so a station-board-only dataset misses
exactly the trains that most often win a crossing.

RESPONSE SHAPES ARE NOT ASSUMED. RailRadar returns lists, {trains:[...]} and
{data:{trains:[...]}} in different places in this project's history, and train
numbers arrive as both int and str. Everything goes through `coerce_trains()`
and `str()` normalisation; anything unparseable is COUNTED AND REPORTED rather
than silently dropped, because a quiet parse failure here looks identical to
"that station has no trains".
"""
import os, sys, json, glob, argparse, datetime, collections

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(ROOT, ".cache")
RAW = os.path.join(CACHE, "corridor_raw")
OUT = os.path.join(CACHE, "konkan_full_corridor_trains.json")
STATIONS_JSON = os.path.join(ROOT, "src", "data", "konkan-corridor-stations.json")
CORRIDOR_DIR = os.path.join(CACHE, "corridor")

sys.path.insert(0, ROOT)

# The precedence ladder. Deliberately the SAME ordering as conflict.normalise_type
# so this dataset and the live conflict model can never disagree about who yields;
# it is imported below rather than restated, and only the fallback lives here.
#
# It is OUR HEURISTIC over a train-type string, not official Indian Railways
# precedence — real precedence is a Section Controller's judgement (VERIFIED #18).
FALLBACK_RANK = 6


def coerce_trains(payload):
    """
    Pull a list of train dicts out of whatever shape arrived.
    Returns (trains, shape_label) so the caller can report what it saw.
    """
    if payload is None:
        return [], "null"
    if isinstance(payload, list):
        return [t for t in payload if isinstance(t, dict)], "list"
    if isinstance(payload, dict):
        for key in ("trains", "data", "results", "items"):
            inner = payload.get(key)
            if isinstance(inner, list):
                return [t for t in inner if isinstance(t, dict)], f"dict.{key}"
            if isinstance(inner, dict):
                got, lbl = coerce_trains(inner)
                if got:
                    return got, f"dict.{key}->{lbl}"
        # A bare dict keyed by train number is also plausible.
        vals = [v for v in payload.values() if isinstance(v, dict)]
        if vals and all(("trainNumber" in v or "number" in v) for v in vals):
            return vals, "dict-keyed-by-number"
    return [], f"unrecognised:{type(payload).__name__}"


def unwrap(t):
    """
    Return (train_meta, stop_meta) for one element of a `trains` list.

    RailRadar wraps each entry: `{"train": {...}, "stop": {...}}` on a station
    board, and `{"train": {...}, "from": {...}, "to": {...}}` on a between-sweep.
    The identity fields live inside `train`, the times inside `stop`/`from`/`to`.

    THIS IS WHY THE FIRST MERGE FOUND ZERO TRAINS. `coerce_trains()` located the
    list correctly and the shape reported as `dict.trains`, so nothing looked
    broken — but every number was read from the WRAPPER, which has no `number`
    key, so all 138 files parsed "successfully" into nothing. A flat lookup is
    kept as the fallback in case a future response is not wrapped.
    """
    if not isinstance(t, dict):
        return {}, {}
    inner = t.get("train")
    if isinstance(inner, dict):
        stop = t.get("stop")
        if not isinstance(stop, dict):
            # Between-sweep: `from` carries this train's departure at the
            # checkpoint. Prefer it over `to` so the time is the earlier one.
            for k in ("from", "to"):
                cand = t.get(k)
                if isinstance(cand, dict):
                    stop = cand
                    break
        return inner, (stop if isinstance(stop, dict) else {})
    return t, t                            # unwrapped shape — read fields flat


def train_number(t):
    for k in ("trainNumber", "number", "train_no", "trainNo", "no"):
        v = t.get(k)
        if v not in (None, ""):
            return str(v).strip()          # int 12051 and "12051" must not split
    return None


def train_name(t):
    for k in ("trainName", "name", "train_name"):
        v = t.get(k)
        if v:
            return str(v).strip()
    return None


def train_category(t):
    for k in ("type", "category", "trainType", "trainCategory", "classType"):
        v = t.get(k)
        if v:
            return str(v).strip()
    return None


def run_days(t):
    """
    Which weekdays this service runs.

    Load-bearing for the conflict model, not decoration: a crossing against a
    train that runs only on Tuesdays is not a crossing on a Wednesday. Without
    this the roster would silently imply every train is daily.
    """
    v = t.get("runDays") or t.get("run_days") or t.get("days")
    if isinstance(v, list):
        return [str(x).strip().lower() for x in v if x]
    if isinstance(v, str) and v.strip():
        return [v.strip().lower()]
    return None


def new_record(num, t):
    return {
        "train_number": num,
        "train_name": train_name(t),
        "category": train_category(t),
        "run_days": run_days(t),
        "origin": (t.get("source") or {}).get("code")
                  if isinstance(t.get("source"), dict) else None,
        "destination": (t.get("destination") or {}).get("code")
                       if isinstance(t.get("destination"), dict) else None,
        "stops_on_corridor": False,
        "through_only": False,
        "corridor_stations": [],
        "_halts": {},
        "_seen_between": [],
    }


def sched_times(t):
    """
    Scheduled arrival/departure at this station, if the board supplied them.

    `t` here is the STOP block, not the train block. `arrivalDay` /
    `departureDay` are carried through because they are what make times
    comparable across trains (VERIFIED #16) — a bare "00:05" is meaningless
    without knowing it is day 2 of that train's run.
    """
    out = {}
    for src, dst in (("scheduledArrival", "arr"), ("arrivalTime", "arr"),
                     ("sta", "arr"), ("arrival", "arr"),
                     ("scheduledDeparture", "dep"), ("departureTime", "dep"),
                     ("std", "dep"), ("departure", "dep")):
        v = t.get(src)
        if v and dst not in out:
            out[dst] = str(v).strip()
    for src, dst in (("arrivalDay", "arrDay"), ("departureDay", "depDay"),
                     ("day", "day")):
        v = t.get(src)
        if v is not None and dst not in out:
            out[dst] = v
    for src, dst in (("sequence", "seq"), ("distance", "trainKm"),
                     ("stopType", "stopType")):
        v = t.get(src)
        if v is not None:
            out[dst] = v
    return out or None


def load_train_payload_types():
    """
    `type` as the TRAIN's own payload reports it, from `.cache/corridor/`.

    Two RailRadar endpoints disagree about what a train is, and the disagreement
    moves precedence. For 12051/12052 the station board says `Shatabdi Express`
    (rank 2) while the train payload says `JAN SHATABDI` (rank 3) — a real rank
    change, not a formatting variant like `MAIL EXPRESS` vs `Mail/Express`.

    The train payload wins. A station board describes a STOP and evidently
    generalises the service name; the train payload describes the train, and
    12051 is factually a Jan Shatabdi. Both are kept in the output so the choice
    is auditable and reversible — source data is never overwritten.

    Free: these files are already on disk (built by scripts/build_corridor.py).
    """
    out = {}
    if not os.path.isdir(CORRIDOR_DIR):
        return out
    for p in glob.glob(os.path.join(CORRIDOR_DIR, "*.json")):
        try:
            d = json.load(open(p))
        except Exception:                          # noqa: BLE001 — a bad file is not fatal
            continue
        num, ty = d.get("number"), d.get("type")
        if num and ty:
            out[str(num).strip()] = str(ty).strip()
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--dry-run", action="store_true", help="report only, write nothing")
    args = ap.parse_args()

    if not os.path.isdir(RAW):
        print(f"ERROR: {RAW} does not exist. Run scripts/fetch_konkan_corridor.py first.")
        return 1

    meta = json.load(open(STATIONS_JSON))
    corridor = {s["code"]: s for s in meta["stations"]}

    # conflict.py owns the ladder; import it so the two cannot drift.
    try:
        import conflict
        rank_of = lambda c: conflict.normalise_type(c)
        ladder_source = "conflict.normalise_type (shared with the live model)"
    except Exception as e:                             # noqa: BLE001
        print(f"WARNING: conflict.py unavailable ({e}); ranks fall back to {FALLBACK_RANK}")
        rank_of = lambda c: ((c or "Unknown"), FALLBACK_RANK)
        ladder_source = f"fallback (conflict.py unavailable: {type(e).__name__})"

    trains = {}          # number -> record
    shapes = collections.Counter()
    # Two DIFFERENT failure modes that must never be pooled: a board that
    # genuinely lists no trains (fine — some minor halts have none on the queried
    # day) versus a payload whose shape we could not read (a real defect that
    # silently looks identical to the first). Only the second needs action.
    empty, unparsed = [], []
    # A THIRD failure mode, and the one that actually bit: the file parsed, the
    # list was found, but an element's train number could not be read. The first
    # run of this script dropped all 138 files this way and reported a clean
    # "0 trains" — so a silent `continue` here is not acceptable.
    dropped = []
    station_files = sorted(glob.glob(os.path.join(RAW, "station_*.json")))
    between_files = sorted(glob.glob(os.path.join(RAW, "between_*.json")))

    def note_miss(path, shape):
        entry = (os.path.basename(path), shape)
        (unparsed if shape.startswith("unrecognised") else empty).append(entry)

    # ---- Step 2: trains that STOP -----------------------------------------
    for p in station_files:
        code = os.path.basename(p)[len("station_"):-len(".json")]
        got, shape = coerce_trains(json.load(open(p)))
        shapes[shape] += 1
        if not got:
            note_miss(p, shape)
        for raw in got:
            t, stop = unwrap(raw)
            num = train_number(t)
            if not num:
                dropped.append((os.path.basename(p), sorted(raw)[:6]))
                continue
            r = trains.setdefault(num, new_record(num, t))
            r["stops_on_corridor"] = True
            r["train_name"] = r["train_name"] or train_name(t)
            r["category"] = r["category"] or train_category(t)
            r["run_days"] = r["run_days"] or run_days(t)
            if code not in r["_halts"]:
                r["_halts"][code] = sched_times(stop)

    # ---- Step 3: trains that DON'T stop -----------------------------------
    for p in between_files:
        key = os.path.basename(p)[len("between_"):-len(".json")]
        got, shape = coerce_trains(json.load(open(p)))
        shapes[shape] += 1
        if not got:
            note_miss(p, shape)
        for raw in got:
            t, _ = unwrap(raw)
            num = train_number(t)
            if not num:
                dropped.append((os.path.basename(p), sorted(raw)[:6]))
                continue
            r = trains.setdefault(num, new_record(num, t))
            r["train_name"] = r["train_name"] or train_name(t)
            r["category"] = r["category"] or train_category(t)
            r["run_days"] = r["run_days"] or run_days(t)
            r["_seen_between"].append(key)

    # ---- Step 4: tag + Step 5: classify ----------------------------------
    payload_types = load_train_payload_types()
    divergences = []
    for r in trains.values():
        r["through_only"] = not r["stops_on_corridor"]

        board_cat = r["category"]                       # as the station board said
        train_cat = payload_types.get(r["train_number"])  # as the train payload said
        board_label, board_rank = rank_of(board_cat)

        # Precedence comes from the train payload where we have one.
        if train_cat:
            train_label, train_rank = rank_of(train_cat)
            if train_rank != board_rank:
                divergences.append({
                    "train_number": r["train_number"],
                    "train_name": r["train_name"],
                    "stationBoardType": board_cat,
                    "stationBoardRank": board_rank,
                    "trainPayloadType": train_cat,
                    "trainPayloadRank": train_rank,
                    "rankUsed": train_rank,
                    "conflictRelevant": None,           # filled in below
                })
            label, rank, src = train_label, train_rank, "train-payload"
        else:
            label, rank, src = board_label, board_rank, "station-board"

        r["category_station_board"] = board_cat
        r["category_train_payload"] = train_cat
        r["category_normalised"] = label
        r["priority_rank"] = rank
        r["priority_source"] = src
        # Corridor stations in corridor order, with times where the board had them.
        r["corridor_stations"] = [
            {"code": c, "name": corridor[c]["name"], "seq": corridor[c]["seq"],
             "kmFromRoha": corridor[c]["kmFromRoha"],
             "section": corridor[c]["section"],
             "scheduled": r["_halts"][c]}
            for c in sorted(r["_halts"], key=lambda x: corridor[x]["seq"])
            if c in corridor
        ]
        r["corridor_station_count"] = len(r["corridor_stations"])
        r["touches_single_line"] = any(
            s["section"] == "konkan-railway-single-line" for s in r["corridor_stations"])
        r["found_in_between_sweeps"] = sorted(set(r.pop("_seen_between")))
        r.pop("_halts")
        # THE FIELD THE CONFLICT MODEL SHOULD FILTER ON.
        #
        # 1,420 of these trains are Mumbai suburban EMUs running CSMT->PNVL on
        # Central Railway DOUBLE line, where a meet needs no hold at all
        # (VERIFIED #17). They are 76% of the roster and 0% of the crossing risk.
        # Kept in the file because the roster is the roster — dropping them would
        # hide the corridor's real composition — but flagged so no consumer has to
        # re-derive the section rule, and so nobody quotes 1,859 as a conflict
        # count.
        r["conflict_relevant"] = r["touches_single_line"]

    # A divergence only has consequences if the train can actually force a hold.
    rel_by_num = {r["train_number"]: r["conflict_relevant"] for r in trains.values()}
    for d in divergences:
        d["conflictRelevant"] = rel_by_num.get(d["train_number"], False)

    # ---- Step 6: sanity checks -------------------------------------------
    KNOWN = {
        "22229": "our reference train (CSMT-Madgaon Vande Bharat, down)",
        "22230": "our reference train (up)",
        "20111": "Konkan Kanya Express (down)",
        "20112": "Konkan Kanya Express (up)",
        "10103": "Mandovi Express (down)",
        "10104": "Mandovi Express (up)",
        "12051": "Jan Shatabdi (down) — the live fleet train",
        "12052": "Jan Shatabdi (up)",
    }
    sanity = {}
    for num, why in KNOWN.items():
        r = trains.get(num)
        sanity[num] = {
            "description": why,
            "found": r is not None,
            "stops_on_corridor": bool(r and r["stops_on_corridor"]),
            "through_only": bool(r and r["through_only"]),
            "corridor_stations": (r["corridor_station_count"] if r else 0),
        }

    relevant = [r for r in trains.values() if r["conflict_relevant"]]
    by_cat = collections.Counter(r["category_normalised"] for r in trains.values())
    by_cat_rel = collections.Counter(r["category_normalised"] for r in relevant)
    through = sorted((r for r in trains.values() if r["through_only"]),
                     key=lambda r: r["train_number"])

    # ---- Report ----------------------------------------------------------
    print(f"Raw responses read: {len(station_files)} station boards, "
          f"{len(between_files)} between-sweeps")
    print(f"Response shapes seen: {dict(shapes)}")
    if empty:
        print(f"\nEMPTY BOARDS ({len(empty)}) — parsed fine, listed no trains. Expected at "
              f"minor halts; only suspicious if a busy station appears here:")
        print(f"  {', '.join(n.replace('station_','').replace('.json','') for n, _ in empty)}")
    if unparsed:
        print(f"\nUNPARSED ({len(unparsed)}) — a shape coerce_trains() could not read. "
              f"This is a DEFECT, not an empty station, and these trains are missing "
              f"from the dataset:")
        for name, shape in unparsed[:20]:
            print(f"  {name:<34} shape={shape}")
        if len(unparsed) > 20:
            print(f"  ... and {len(unparsed)-20} more")

    if dropped:
        print(f"\nDROPPED ENTRIES ({len(dropped)}) — the list parsed but no train "
              f"number could be read. This is a DEFECT (it is what made the first "
              f"run report 0 trains); the keys actually present are shown:")
        for name, keys in dropped[:10]:
            print(f"  {name:<34} keys={keys}")
        if len(dropped) > 10:
            print(f"  ... and {len(dropped)-10} more")

    print(f"\n{'='*66}\nTOTAL UNIQUE TRAINS: {len(trains)}\n{'='*66}")
    print(f"  stop on corridor : {sum(1 for r in trains.values() if r['stops_on_corridor'])}")
    print(f"  through only     : {len(through)}")
    print(f"  touch single line: {sum(1 for r in trains.values() if r['touches_single_line'])}")

    print(f"\nBy category (ladder: {ladder_source}) — 'single' = touches the "
          f"single-line section, the only trains that can force a hold:")
    print(f"  {'rank':<6}{'category':<18}{'all':>6}{'single':>8}")
    for cat, n in sorted(by_cat.items(), key=lambda kv: (rank_of(kv[0])[1], kv[0])):
        print(f"  {rank_of(cat)[1]:<6}{cat:<18}{n:>6}{by_cat_rel.get(cat, 0):>8}")

    print(f"\nTHROUGH-ONLY TRAINS ({len(through)}) — found only by the between-sweep, "
          f"halt at no corridor station we polled:")
    if not through:
        print("  (none)")
    for r in through:
        print(f"  {r['train_number']:<8} {(r['train_name'] or '?')[:38]:<38} "
              f"{r['category_normalised']:<14} rank {r['priority_rank']}")

    print(f"\nSANITY CHECKS:")
    for num, s in sanity.items():
        flag = "FOUND  " if s["found"] else "MISSING"
        extra = (f"{s['corridor_stations']} corridor stations"
                 if s["found"] else "-- investigate: code mismatch / not running today / parse shape")
        print(f"  {flag} {num:<7} {s['description'][:44]:<44} {extra}")

    missing = [n for n, s in sanity.items() if not s["found"]]
    if missing:
        print(f"\n  {len(missing)} known train(s) missing: {', '.join(missing)}")
        print(f"  Do NOT assume incomplete data. Check, in order:")
        print(f"    1. is the number right? (20111/20112 Konkan Kanya vs 10111/10112 — "
              f"both have circulated)")
        print(f"    2. weekly/biweekly service not running on the queried day")
        print(f"    3. the station board returned a shape coerce_trains() missed — "
              f"grep the raw file for the number")

    if args.dry_run:
        print(f"\n--dry-run: nothing written.")
        return 0

    payload = {
        "_meta": {
            "built": datetime.datetime.now().isoformat(timespec="seconds"),
            "purpose": ("Every train on the Konkan corridor that could cross or precede "
                        "our train, for crossing/precedence conflict prediction."),
            "corridorStations": len(corridor),
            "stationBoardsRead": len(station_files),
            "betweenSweepsRead": len(between_files),
            "totalUniqueTrains": len(trains),
            "conflictRelevantTrains": len(relevant),
            "totalsNote": ("TWO different totals, do not conflate them. "
                           f"{len(trains)} is the full corridor roster. "
                           f"{len(relevant)} touch the single-line section and are "
                           "the only trains that can force a loop hold — the rest "
                           "are Mumbai suburban EMUs on Central Railway double "
                           "line, where a meet needs no hold (VERIFIED #17). "
                           "Filter on `conflict_relevant`. Never quote the roster "
                           "total as a conflict count."),
            "throughOnlyCount": len(through),
            "throughOnlyFinding": (
                "ZERO, and this RETRACTS the premise the Step 3 sweep was built "
                "on. The 23 between-station sweeps returned 580 unique trains and "
                "EVERY ONE also appears on some station board, so no train was "
                "found that halts nowhere we polled. The sweep was not wasted — it "
                "independently corroborates that the boards cover the corridor — "
                "but the expected class of board-invisible high-priority through "
                "trains does not exist here. Do not describe this dataset as "
                "catching trains a station-board approach would miss."),
            "runDaysPresent": sum(1 for r in trains.values() if r["run_days"]),
            "runDaysNote": ("`run_days` is load-bearing, not decoration: a crossing "
                            "against a Tuesday-only train is not a crossing on a "
                            "Wednesday. Trains without it must not be assumed daily."),
            "ladderSource": ladder_source,
            "priorityIsOfficial": False,
            "priorityNote": ("The rank is OUR heuristic over the train type string, not "
                             "official Indian Railways precedence (VERIFIED #18). The real "
                             "call is a Section Controller's."),
            "sourceIsOfficial": False,
            "sourceNote": ("RailRadar station boards and between-station sweeps "
                           "(crowdsourced-GPS tier), not official Indian Railways data."),
            "ttl": ("Semi-static schedule data — schedules change at timetable revisions, "
                    "not daily. Do NOT refetch on every run; the sweep costs ~139 requests "
                    "of a 1,000/month quota."),
            "coverageCaveat": ("Station boards return HALTS only "
                               "(`includeIntermediate: false` on all 115 responses). "
                               "A train passing a station without stopping is absent "
                               "from that board; the between-sweeps were the "
                               "compensation and found no such train (see "
                               "throughOnlyFinding). Residual risk: a train confined "
                               "to one checkpoint gap could still be missed — the "
                               "widest gap is 6 stations (VRLI-ACRN)."),
            "emptyBoards": [n for n, _ in empty],
            "unparsedFiles": [{"file": n, "shape": s} for n, s in unparsed],
            "droppedEntries": [{"file": n, "keys": k} for n, k in dropped],
            "notLive": ("Positions and delays are NOT here. This is the static corridor "
                        "roster; only our own train's delay is ever live (VERIFIED #15)."),
            "sanityChecks": sanity,
        },
        "trains": sorted(trains.values(), key=lambda r: r["train_number"]),
    }
    with open(OUT, "w") as f:
        json.dump(payload, f, indent=2)
    size = os.path.getsize(OUT)
    print(f"\nWrote {OUT} ({size/1024:.1f} KB, {len(trains)} trains)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
