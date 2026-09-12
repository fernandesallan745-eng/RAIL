"""
corridor_axis.py — the one canonical chainage axis for the Konkan corridor.

Why this exists
---------------
Every train on this corridor carries its own km axis, zeroed at its own origin.
Roha is km 142.2 on a down train out of CSMT, km 440.0 on an up train, and km
203.8 on one that starts at Ratnagiri.  Anything that needs to reason about
*where on the corridor* a train is — which section it is on, whether two trains
are at the same place — cannot use a per-train axis without first agreeing on a
common one.

`conflict.single_line_span()` tried to derive that agreement per train, by
finding Roha and Madgaon on the train's own axis and taking the span between
them.  It works when both anchors are present and fails otherwise:

    01446 (Ratnagiri -> Panvel):  own km  RN 0.0 ... ROHA 203.8 ... PNVL 278.2
      one-anchor branch   ->  [203.8, 278.2]   the DOUBLE-line Mumbai side
      truth               ->  [0.0, 203.8]     the single-line Konkan side

113 of the 206 roster trains take that branch, and every one of them then
rejects all 209 counterparts as "shares too little of the single-line section".

The fix is not a better guess.  The dataset already carries the answer.

What the dataset already has (verified 2026-09-11, and re-checked by audit())
-----------------------------------------------------------------------------
Every station row in `.cache/konkan_full_corridor_trains.json` carries:

    {"code": "ROHA", "kmFromRoha": 0.0, "section": "konkan-railway-single-line"}

- **113 distinct station codes carry `kmFromRoha`, with ZERO disagreements**
  across all 1859 train records.  It is a genuine shared axis, not a per-train
  figure that happens to be repeated.
- **`section` is equally consistent — zero codes disagree with themselves.**
  It is authoritative single-line membership, requiring no anchoring, no
  direction inference and no arithmetic: `central-railway-double-line` spans
  km -142.2..-4.1, `konkan-railway-single-line` spans 0.0..737.1.
- It is the *same* axis the corridor-cache trains use, merely shifted: 12051's
  own km maps onto it at **scale 1.0000, max residual 0.00 km**.
- It reaches the southern corridor no cached train covers: MAO 440.1 ->
  KAWR 500.3 -> KT 555.5 -> **TOK 737.1**.

Known gaps, reported rather than patched
----------------------------------------
**MRJN and NAND are labelled single-line but carry no `kmFromRoha`** (6 station
rows in total).  They can be classified but not placed.  `station_km` returns
None for them and they are counted in `coverage()['unplaced']` — a station that
cannot be located must not be silently dropped from a walk that decides where
two trains meet.

This module makes **no API calls** and reads one cached file, once.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
FULL_DATASET_PATH = os.path.join(HERE, ".cache", "konkan_full_corridor_trains.json")

SINGLE_LINE = "konkan-railway-single-line"
DOUBLE_LINE = "central-railway-double-line"

# The section boundary, on the canonical axis.  Roha is the origin by
# construction (kmFromRoha), so this is 0.0 by definition rather than by
# measurement — stated explicitly because VERIFIED #17 is about exactly this
# number having been a hardcoded 142.2 on a per-train axis.
ROHA_CANONICAL_KM = 0.0

_axis = None


def _build():
    """Read the dataset once and invert it into code-keyed lookup tables."""
    table = {"km": {}, "section": {}, "name": {}, "loaded": False, "path": FULL_DATASET_PATH}
    if not os.path.exists(FULL_DATASET_PATH):
        return table

    with open(FULL_DATASET_PATH) as f:
        raw = json.load(f)

    # Conflicting values would make the whole premise of a shared axis false, so
    # they are collected rather than last-write-wins.  Measured empty today; the
    # check stays because a dataset rebuild could reintroduce one silently.
    km_seen, sec_seen = {}, {}
    for record in raw.get("trains", []):
        for s in record.get("corridor_stations") or []:
            code = s.get("code")
            if not code:
                continue
            k = s.get("kmFromRoha")
            if k is not None:
                km_seen.setdefault(code, set()).add(round(float(k), 1))
            sec = s.get("section")
            if sec:
                sec_seen.setdefault(code, set()).add(sec)
            if s.get("name"):
                table["name"].setdefault(code, s["name"])

    table["km"] = {c: next(iter(v)) for c, v in km_seen.items() if len(v) == 1}
    table["section"] = {c: next(iter(v)) for c, v in sec_seen.items() if len(v) == 1}
    table["kmConflicts"] = sorted(c for c, v in km_seen.items() if len(v) > 1)
    table["sectionConflicts"] = sorted(c for c, v in sec_seen.items() if len(v) > 1)
    table["loaded"] = True
    return table


def _table():
    global _axis
    if _axis is None:
        _axis = _build()
    return _axis


def available():
    """Is the canonical axis usable at all?  False means every caller must fall back."""
    t = _table()
    return t["loaded"] and bool(t["km"])


def station_km(code):
    """Canonical chainage (km from Roha, negative toward Mumbai), or None.

    None means one of two different things and the caller must not conflate
    them: an off-corridor station, or MRJN/NAND which are on the corridor but
    carry no km.  Use `section_of` to tell them apart.
    """
    return _table()["km"].get(code)


def section_of(code):
    """'konkan-railway-single-line' | 'central-railway-double-line' | None."""
    return _table()["section"].get(code)


def is_single_line(code):
    """True / False / None (unknown code — caller must decide, not assume)."""
    sec = section_of(code)
    return None if sec is None else sec == SINGLE_LINE


def annotate(train):
    """Add `corridorKm` and `onSingleLine` to every station of `train`, in place.

    Joined on station CODE, which VERIFIED #15 already established as a perfect
    join key across this corridor.  Works identically for both train sources:
    the corridor cache (rich, with lat/lng) and the 206-train roster (halts
    only) — neither needs to carry the canonical axis itself.

    Stations off the canonical axis keep `corridorKm: None`; they are NOT
    dropped here.  Dropping is the caller's decision and must be counted, so
    `coverage()` exists to count it.
    """
    for s in train.get("stations") or []:
        code = s.get("code")
        s["corridorKm"] = station_km(code)
        s["onSingleLine"] = is_single_line(code)
    train["_axisAnnotated"] = True
    return train


def coverage(train):
    """How much of `train` the canonical axis can actually place.

    Returned as counts, never as a bare boolean: a train with 5 of 127 stations
    on the corridor and one with 127 of 127 are both "covered" under any
    threshold, and the difference decides whether a predicted meet is trustworthy.
    """
    stations = train.get("stations") or []
    on_axis = [s for s in stations if s.get("corridorKm") is not None]
    single = [s for s in on_axis if s.get("onSingleLine")]
    # On the corridor by section, but with no km — placeable in class, not in space.
    unplaced = [s for s in stations
                if s.get("corridorKm") is None and s.get("onSingleLine") is not None]
    span = (round(max(s["corridorKm"] for s in single)
                  - min(s["corridorKm"] for s in single), 1)
            if len(single) >= 2 else 0.0)
    return {
        "stations": len(stations),
        "onAxis": len(on_axis),
        "offAxis": len(stations) - len(on_axis) - len(unplaced),
        "unplaced": len(unplaced),
        "unplacedCodes": sorted({s["code"] for s in unplaced}),
        "singleLineStations": len(single),
        "singleLineSpanKm": span,
        "singleLineRangeKm": (
            [round(min(s["corridorKm"] for s in single), 1),
             round(max(s["corridorKm"] for s in single), 1)]
            if single else None
        ),
    }


def audit():
    """Re-verify the properties the docstring claims. Used by tests and the CLI."""
    t = _table()
    km, sec = t["km"], t["section"]
    single = sorted((c for c in sec if sec[c] == SINGLE_LINE and c in km),
                    key=lambda c: km[c])
    return {
        "path": t["path"],
        "loaded": t["loaded"],
        "codesWithKm": len(km),
        "codesWithSection": len(sec),
        "kmConflicts": t.get("kmConflicts", []),
        "sectionConflicts": t.get("sectionConflicts", []),
        "singleLineCodes": len(single),
        "singleLineRangeKm": [km[single[0]], km[single[-1]]] if single else None,
        "doubleLineCodes": sum(1 for c in sec.values() if c == DOUBLE_LINE),
        "sectionButNoKm": sorted(c for c in sec if c not in km),
    }


if __name__ == "__main__":
    import sys
    a = audit()
    print(f"canonical corridor axis  [{a['path']}]")
    print(f"  loaded                : {a['loaded']}")
    print(f"  codes with kmFromRoha : {a['codesWithKm']}")
    print(f"  codes with section    : {a['codesWithSection']}")
    print(f"  single-line codes     : {a['singleLineCodes']}  "
          f"km {a['singleLineRangeKm'][0]} -> {a['singleLineRangeKm'][1]}")
    print(f"  double-line codes     : {a['doubleLineCodes']}")
    print(f"  km disagreements      : {a['kmConflicts'] or 'none'}")
    print(f"  section disagreements : {a['sectionConflicts'] or 'none'}")
    print(f"  section but no km     : {a['sectionButNoKm'] or 'none'}  "
          f"(classifiable, not placeable)")
    sys.exit(0 if a["loaded"] and not a["kmConflicts"] and not a["sectionConflicts"] else 1)
