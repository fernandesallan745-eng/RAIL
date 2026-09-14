"""
hazard_layer.py — confirmed crowdsourced hazards as an ETA speed-cap layer (Phase 7).

Reads the hazard store the Node gateway writes (`src/data/hazards.json`) and turns
**human-confirmed** reports into per-block speed restrictions.  Cache-only, no
network, **zero upstream RailRadar requests** — hazards are our own data.

WHAT GATES THIS LAYER
---------------------
Three gates, in order, and each one is the point of a CLAUDE.md rule:

  1. `hazards=True` must be passed.  Off by default, copying the `conflicts=False`
     contract — every number in §4b stays reproducible and a missing/empty store
     can never change an existing result.
  2. The report's status must be **`confirmed`**, which only a human can set
     (`HUMAN_ONLY` in src/services/hazardStore.js).  §2: "All conflict alerts and
     hazard escalations require human confirmation."  A `corroborated` report —
     the machine's ceiling — does NOT move the ETA.
  3. The category must be in `HAZARD_SPEED_CAP_KMH`.  See that table for why
     several categories are deliberately absent.

WHY THE CAP IS NOT APPLIED BLOCK-WIDE
-------------------------------------
VERIFIED #6, restated for hazards.  Applying a block's worst restriction across
the whole block overstated curvature by **~2,200×** (R=268 m covers ~80 m of a
175 km block).  A landslide restricts ~1 km of track, not all 175 km of
PNVL→KHED.  So the penalty is computed from the **overlap** between the hazard's
km span and the block, distance-weighted:

    penalty_min = Σ overlap_km × (60/min(v_normal, cap) − 60/v_normal)

which is ≥ 0 by construction (a hazard can never make a train faster) and exactly
0 when the cap is looser than the speed the block already runs at.

WHY IT IS AN ADDITIVE LAYER, NOT A FOLD INTO THE PER-VERTEX LOOP
----------------------------------------------------------------
The Phase 7 plan said to fold the cap into `block_vertex_running_min`'s per-vertex
loop.  Reading the code, that mechanism is wrong three times over — the intent
(sub-span, never block-wide) is right and is what this module implements:

  * `compute_eta`'s `running_min` total comes from the block-mode `effective`
    speed, NOT from `block_vertex_running_min`.  A cap folded only into that loop
    would be invisible to `report_eta.py`, the CLI and `mode=block`, and would
    appear only in `api.py`'s vertex branch.
  * **44 of 210 roster trains have no geometry at all** (VERIFIED #25), so that
    loop never runs for them and the hazard layer would score a silent 0.0 —
    VERIFIED #9 exactly.
  * The loop's distances are renormalised per block (`norm = block_km / geom_km`)
    and carry no absolute chainage, so a hazard span could not be located inside
    it without re-deriving the axis a fifth time.

Distance-weighted overlap needs no geometry, works identically in both curvature
modes, and stays auditable as its own number the way `vertex_curve_penalty_min`
is.
"""
import json
import math
import os

import corridor_axis as axis
import corridor_geometry as cgeom

HERE = os.path.dirname(os.path.abspath(__file__))
STORE_PATH = os.path.join(HERE, "src", "data", "hazards.json")

# ────────────────────────────────────────────────────────────────────────────
#  Speed caps per category — OUR HEURISTIC, not sourced TSR values
# ────────────────────────────────────────────────────────────────────────────
# Same honesty class as `curvature.WEATHER_SPEED_FACTOR` (untuned placeholders,
# CLAUDE.md §3) and the conflict precedence ladder (`priorityIsOfficial: false`,
# VERIFIED #18).  These are plausible temporary-speed-restriction magnitudes, not
# figures taken from an IR TSR circular, and `capsAreHeuristic: true` travels with
# every number this module produces.  Do not present them as railway policy.
#
# CATEGORIES DELIBERATELY ABSENT — and this is a correctness point, not an
# oversight.  `engine-failure`, `medical`, `overcrowding`, `unusual-stop` and
# `other` describe the condition of a TRAIN or a non-geometric event.  None of
# them says anything about the state of the track, so none implies a speed
# restriction for a following train.  Inventing a cap for them would fabricate
# physics from a report that contains none — and an engine failure is a section
# BLOCKAGE, which is a different model (occupancy) than a speed cap, so
# approximating it as one would be wrong rather than merely rough.
HAZARD_SPEED_CAP_KMH = {
    "landslide":      15.0,   # debris + unstable slope: crawl, visual inspection
    "track-damage":   15.0,   # buckled rail / washed ballast
    "flooding":       20.0,   # water over rail level, wheel-slip and scour risk
    "obstruction":    20.0,   # object or vehicle fouling the track
    "fire":           20.0,   # smoke obscuring signals, fire near formation
    "signal-failure": 25.0,   # proceeding on written/verbal authority
}

# Half-width of the restriction, km.  A restriction applies to a STRETCH, not a
# point: the reporter's GPS is only good to a few hundred metres (TUNING.
# corridorNearM is 1500 m for the same reason), and a real TSR is imposed over a
# length of track with approach warning boards.  ±0.5 km → a 1.0 km span, which
# is also comfortably wider than the 229 m worst-case placement error measured by
# the leave-one-out anchor test.
HAZARD_SPAN_HALF_KM = 0.5


def load_store(path=None):
    """Read the hazard store.  Returns (reports, meta, unavailable_reason).

    A missing file is `unavailable`, NOT an empty list — "nobody has reported
    anything" and "the store is not there" are different facts, and collapsing
    them is the VERIFIED #9 failure.  The caller reports the reason.
    """
    p = path or STORE_PATH
    if not os.path.exists(p):
        return [], {}, "hazard-store-absent"
    try:
        with open(p, "r", encoding="utf-8") as fh:
            j = json.load(fh)
    except (json.JSONDecodeError, OSError) as e:
        return [], {}, f"hazard-store-unreadable: {type(e).__name__}"
    reports = j.get("reports")
    if not isinstance(reports, list):
        return [], j.get("_meta", {}), "hazard-store-malformed"
    return reports, j.get("_meta", {}), None


def confirmed_reports(reports):
    """The human-confirmed subset, partitioned with a reason for each exclusion.

    Returns (eligible, skipped) where `skipped` carries why — so an operator can
    always see that a report was read and deliberately not applied, rather than
    wondering whether the layer saw it at all.
    """
    eligible, skipped = [], []
    for r in reports:
        if r.get("status") != "confirmed":
            # Includes `corroborated`: the machine's ceiling is NOT enough.
            skipped.append({"id": r.get("id"), "reason": "not-human-confirmed",
                            "status": r.get("status")})
            continue
        if r.get("category") not in HAZARD_SPEED_CAP_KMH:
            skipped.append({"id": r.get("id"), "reason": "category-implies-no-speed-restriction",
                            "category": r.get("category")})
            continue
        eligible.append(r)
    return eligible, skipped


def place_on_corridor(reports, max_offset_m=2000.0):
    """Attach a canonical corridor km to each report by perpendicular projection.

    Derived HERE, in Python, from the report's own immutable lat/lng — never read
    from a persisted field.  The gateway computes its own corridor km for the
    confidence score and does not store it, which is the correct call (VERIFIED
    #21/#29) and also gives the two implementations an independent cross-check.
    """
    placed, unplaceable = [], []
    for r in reports:
        lat, lng = r.get("lat"), r.get("lng")
        if lat is None or lng is None:
            unplaceable.append({"id": r.get("id"), "reason": "no-coordinates"})
            continue
        hit = cgeom.corridor_km_at_point(lat, lng, max_offset_m=max_offset_m)
        if hit is None:
            # Off every cached polyline, or south of MAO where none exists yet.
            # Reported, never pinned to the nearest end (VERIFIED #9).
            unplaceable.append({"id": r.get("id"),
                                "reason": "off-cached-polyline-or-beyond-anchor-span",
                                "lat": lat, "lng": lng})
            continue
        placed.append({**r,
                       "corridorKm": round(hit["corridorKm"], 3),
                       "offsetM": round(hit["offsetM"], 1),
                       "geometryReferenceTrain": hit["referenceTrain"],
                       "anchorGapKm": hit["anchorGapKm"],
                       "capKmph": HAZARD_SPEED_CAP_KMH[r["category"]]})
    return placed, unplaceable


def _own_axis_anchors(stations):
    """[(canonical_km, own_timetable_km)] for one train, sorted on canonical km.

    The train's own `distance` column and the canonical `kmFromRoha` axis are two
    different rulers (VERIFIED #22: Roha is km 142.2 on a down train and km 440.0
    on an up one), so a hazard located on the canonical axis has to be carried
    across.  Anchored between the two nearest station codes, not scaled globally —
    VERIFIED #12, for the same reason tunnels and halts are.

    Works for both directions without a direction flag: sorting on the canonical
    column leaves the own-km column ascending for a down train and descending for
    an up train, and linear interpolation between bracketing anchors is correct
    either way.
    """
    tbl = []
    for s in stations:
        code, own = s.get("stationCode"), s.get("distance")
        if not code or own is None:
            continue
        ckm = axis.station_km(code)
        if ckm is not None:
            tbl.append((ckm, float(own)))
    tbl.sort()
    out = []
    for ckm, own in tbl:
        if out and abs(ckm - out[-1][0]) < 1e-9:
            continue          # a repeated canonical km would divide by zero below
        out.append((ckm, own))
    return out


def _canonical_to_own(anchors, ckm):
    """Interpolate a canonical km onto a train's own timetable axis, or None.

    Refuses to extrapolate past the anchor span: a hazard beyond a train's own
    route is not on that train's journey and must report nothing rather than be
    clamped to its first or last station.
    """
    if len(anchors) < 2 or not (anchors[0][0] <= ckm <= anchors[-1][0]):
        return None
    lo = max(i for i in range(len(anchors)) if anchors[i][0] <= ckm)
    hi = min(len(anchors) - 1, lo + 1)
    if hi == lo:
        lo = hi - 1
    (c0, o0), (c1, o1) = anchors[lo], anchors[hi]
    f = 0.0 if c1 == c0 else (ckm - c0) / (c1 - c0)
    return o0 + f * (o1 - o0), abs(c1 - c0)


def spans_for_train(stations, placed, half_km=HAZARD_SPAN_HALF_KM):
    """Hazard km spans on ONE train's own timetable axis, merged.

    Overlapping spans are merged to the **most restrictive** cap rather than
    summed.  Two people reporting one landslide must not cost twice the minutes —
    that is the same double-count trap as summing the cumulative `delayArrival`
    (VERIFIED #9) and as detecting one meet from both its neighbouring intervals
    (VERIFIED #20).
    """
    anchors = _own_axis_anchors(stations)
    if len(anchors) < 2:
        return [], [{"id": r.get("id"), "reason": "train-has-no-canonical-anchors"} for r in placed]

    raw, off_route = [], []
    for r in placed:
        hit = _canonical_to_own(anchors, r["corridorKm"])
        if hit is None:
            off_route.append({"id": r.get("id"), "reason": "outside-this-train-km-span",
                              "corridorKm": r["corridorKm"]})
            continue
        own_km, gap = hit
        raw.append({"id": r.get("id"), "category": r["category"], "capKmph": r["capKmph"],
                    "corridorKm": r["corridorKm"], "ownKm": round(own_km, 3),
                    "anchorGapKm": gap, "offsetM": r.get("offsetM"),
                    "isSynthetic": bool(r.get("isSynthetic")),
                    "start": own_km - half_km, "end": own_km + half_km})

    # Merge by breakpoints: every elementary interval takes the min cap of the
    # hazards covering it, so an overlap is restricted once, at the tightest cap.
    if not raw:
        return [], off_route
    edges = sorted({e for h in raw for e in (h["start"], h["end"])})
    merged = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        if hi - lo <= 1e-9:
            continue
        mid = (lo + hi) / 2.0
        covering = [h for h in raw if h["start"] <= mid < h["end"]]
        if not covering:
            continue
        cap = min(h["capKmph"] for h in covering)
        merged.append({"startKm": lo, "endKm": hi, "capKmph": cap,
                       "reportIds": [h["id"] for h in covering],
                       "categories": sorted({h["category"] for h in covering}),
                       "isSynthetic": any(h["isSynthetic"] for h in covering)})

    # Coalesce adjacent intervals that ended up with the same cap and the same
    # contributing reports, purely so the payload reads as one restriction.
    out = []
    for m in merged:
        p = out[-1] if out else None
        if (p and abs(p["endKm"] - m["startKm"]) < 1e-9
                and p["capKmph"] == m["capKmph"] and p["reportIds"] == m["reportIds"]):
            p["endKm"] = m["endKm"]
        else:
            out.append(m)
    return out, off_route


def block_penalty_min(spans, d0, d1, normal_speed_kmh):
    """Extra minutes a block loses to hazards, distance-weighted on the overlap.

    `normal_speed_kmh` is the speed the block would otherwise run at, so the
    caller decides which mode's speed to charge against (block-mode `effective`
    or vertex-mode mean) and the same arithmetic serves both.

    Returns (penalty_min, detail).  Never negative: a cap looser than the block's
    own speed contributes exactly 0.0, which is a real zero and is labelled as
    one in `detail`.
    """
    if normal_speed_kmh is None or normal_speed_kmh <= 0 or d1 <= d0:
        return 0.0, []
    total, detail = 0.0, []
    for s in spans:
        lo, hi = max(d0, s["startKm"]), min(d1, s["endKm"])
        ov = hi - lo
        if ov <= 1e-9:
            continue
        cap = s["capKmph"]
        eff = min(normal_speed_kmh, cap)
        add = ov * (60.0 / eff - 60.0 / normal_speed_kmh)
        total += add
        detail.append({
            "report_ids": s["reportIds"], "categories": s["categories"],
            "overlap_km": round(ov, 3),
            "cap_kmph": cap,
            "normal_speed_kmh": round(normal_speed_kmh, 1),
            "applied_speed_kmh": round(eff, 1),
            "penalty_min": round(add, 3),
            "binds": cap < normal_speed_kmh,
            "is_synthetic": s["isSynthetic"],
        })
    return total, detail


def build(train, stations, path=None):
    """Everything `compute_eta` needs for one train.  Cheap; no network.

    Always returns a dict.  `spans` empty with an `unavailableReason` means the
    layer could not run; `spans` empty with `unavailableReason: None` means it ran
    and there genuinely are no confirmed hazards on this train's route.  Those are
    different answers and the payload keeps them apart (VERIFIED #9 / §5e).
    """
    reports, meta, unavailable = load_store(path)
    if unavailable:
        return {"available": False, "unavailableReason": unavailable, "spans": [],
                "totalReports": 0, "confirmedReports": 0, "skipped": [],
                "unplaceable": [], "offRoute": [], "storeMeta": meta}

    eligible, skipped = confirmed_reports(reports)
    placed, unplaceable = place_on_corridor(eligible)
    spans, off_route = spans_for_train(stations, placed)

    return {
        "available": True,
        "unavailableReason": None,
        "spans": spans,
        "totalReports": len(reports),
        "confirmedReports": len(eligible),
        "appliedReports": sorted({rid for s in spans for rid in s["reportIds"]}),
        "restrictedKm": round(sum(s["endKm"] - s["startKm"] for s in spans), 3),
        "skipped": skipped,
        "unplaceable": unplaceable,
        "offRoute": off_route,
        "spanHalfWidthKm": HAZARD_SPAN_HALF_KM,
        "capsKmph": HAZARD_SPEED_CAP_KMH,
        "storeMeta": meta,
        # Honesty block — the UI renders these; do not remove (§5e/§5g).
        "capsAreHeuristic": True,
        "capsBasis": "our-heuristic-not-official-tsr",
        "requiresHumanConfirmation": True,
        "appliedStatuses": ["confirmed"],
        "machineStatusesIgnored": ["logged", "candidate", "corroborated"],
        "decisionSupportOnly": True,
        "upstreamRequestCost": 0,
    }


if __name__ == "__main__":
    import sys
    import eta_model

    train = sys.argv[1] if len(sys.argv) > 1 else eta_model.DEFAULT_TRAIN
    _, stations, src = eta_model.load_schedule(train)
    layer = build(train, stations)

    print(f"hazard layer for {train}  (schedule source: {src})")
    print(f"  store            : {STORE_PATH}")
    print(f"  available        : {layer['available']}  {layer['unavailableReason'] or ''}")
    print(f"  reports in store : {layer['totalReports']}")
    print(f"  human-confirmed  : {layer['confirmedReports']}")
    if not layer["available"]:
        sys.exit(0)
    print(f"  restricted km    : {layer['restrictedKm']}")
    print(f"  span half-width  : ±{layer['spanHalfWidthKm']} km")
    print()
    if layer["spans"]:
        print(f"  {'startKm':>9} {'endKm':>9} {'cap':>6}  reports")
        for s in layer["spans"]:
            print(f"  {s['startKm']:9.3f} {s['endKm']:9.3f} {s['capKmph']:6.1f}  "
                  f"{','.join(s['reportIds'])}  {'/'.join(s['categories'])}"
                  f"{'  [SYNTHETIC]' if s['isSynthetic'] else ''}")
    else:
        print("  no confirmed hazards on this train's route")
    for label, key in (("skipped", "skipped"), ("unplaceable", "unplaceable"),
                       ("off this train's route", "offRoute")):
        if layer[key]:
            print(f"\n  {label}:")
            for x in layer[key]:
                print(f"    {x}")
