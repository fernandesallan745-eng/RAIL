"""
corridor_geometry.py — share one real polyline across every corridor train.

Why this exists
---------------
`.cache/` holds exactly one route-geometry file, `22229_route.json` (1184
vertices, CSMT -> Madgaon).  `eta_model.load_route_coords` opened
`{train}_route.json` and raised otherwise, so `compute_eta`'s `has_geometry`
guard switched the curvature layer off for **205 of 206** roster trains — even
though they run on **the same physical alignment**.  Fetching per-train geometry
would cost 206 upstream requests against a 1000/month tier.

The alignment does not belong to a train.  A curve between Chiplun and Kamathe
is the same curve whichever train is on it, so the polyline can be shared — the
only thing that is per-train is *which stretch of it that train traverses*.

How the sharing is keyed
------------------------
By **station CODE**, snapped once onto each reference polyline through the
reference train's own station lat/lngs.  Code-keying is not a preference, it is
the only option available: **0 of the 1859 full-dataset records carry station
coordinates**, so a target train has nothing to snap with.  It has codes, and
VERIFIED #15 already established station code as a perfect join key here.

Resolution is **per block, not per train**
------------------------------------------
A block `a -> b` gets geometry when both `a` and `b` resolve on the *same*
reference polyline.  Deciding per block rather than per train means:

* no polyline stitching and therefore no seam to verify.  A CSMT -> Mangalore
  train takes its northern blocks from the 22229 reference and reports the
  southern ones as unavailable, instead of the whole train losing curvature or
  gaining a fabricated join.
* a new reference file (e.g. `56615_route.json` for the southern 297 km) is
  picked up at load time and upgrades coverage with no code change and no
  constant to edit — the `loadPackManifest()` pattern of CLAUDE.md 5b.

Measured coverage with the northern reference alone (2026-09-11)
----------------------------------------------------------------
Reference 22229 spans canonical km **-142.2 -> 440.1** and anchors **74**
station codes.  Of the 210 roster trains: **121 fall entirely inside that span**,
**78 overlap it partially** (curvature north of Madgaon, nothing south until the
southern reference is primed), and **11 place no station on the canonical axis
at all**.  Both numbers are reported per train rather than averaged into one
coverage claim.

Honesty (this is the whole point of `geometryBasis`)
----------------------------------------------------
A clipped shared polyline **is the real Konkan alignment**, but it is **not that
train's own route file**.  Same class of caveat as `axisBasis` in VERIFIED #12,
and it travels with every curvature number so the UI can never render the
penalty alone.  Note also VERIFIED #7 and #8: curvature contributes +0.0013 min
on 22229 and the polyline is curvature-blind over 56% of its length, so
extending this layer to 206 trains buys **availability and auditability**, not
accuracy.

No API calls.  Reads cached route files, once each.
"""
import glob
import math
import os

import corridor_axis as axis
import curvature

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache")

# Reference polylines are DISCOVERED, not listed, so priming a new route file is
# the only action needed to widen coverage.  A route file alone is not enough:
# the anchors come from the matching live snapshot's station lat/lngs
# (`includeCoordinates: true`, VERIFIED #13), which is why priming a train
# fetches both.
_refs = None


def _load_json(path):
    import json
    with open(path) as f:
        return json.load(f)


def _route_coords(path):
    """[lng,lat] list, through the extra 'geojson' wrapper of VERIFIED #1."""
    return _load_json(path)["geojson"]["geometry"]["coordinates"]


def _reference_stations(train):
    """Stations with lat/lng for a reference train, from its live snapshot."""
    import json
    candidates = [os.path.join(CACHE, f"{train}_live.json")]
    candidates += sorted(glob.glob(os.path.join(CACHE, f"{train}_live_20*.json")))
    for path in candidates:
        if not os.path.exists(path):
            continue
        route = _load_json(path).get("route") or []
        out = [s for s in route
               if s.get("lat") is not None and s.get("lng") is not None
               and s.get("stationCode")]
        if out:
            return out, os.path.basename(path)
    return [], None


def _perp_offset_m(coords, i, slat, slng, window=3):
    """Distance from a station to the nearest POINT ON the polyline near vertex `i`.

    Distinct from the distance to the nearest vertex, and the distinction is the
    whole finding of VERIFIED #11 recurring here.  Vertex spacing on this route
    is median ~195 m but runs to 11.9 km (VERIFIED #8), so a station inside a
    long span is kilometres from any vertex while sitting metres from the line.
    Measured on the 22229 reference: to-nearest-vertex median 319 m / max
    3097 m, to-nearest-LINE median 22 m / max 479 m, and **0 of 82 stations are
    genuinely more than 800 m off the alignment**.  SNDD is the extreme — 3097 m
    from its nearest vertex, 17 m from the line, inside an 11,923 m span.

    Reported because the vertex figure alone reads as 3 km of sloppy anchoring
    and would wrongly discredit the sharing this module depends on.
    """
    best = math.inf
    for j in range(max(0, i - window), min(len(coords) - 1, i + window)):
        (x0, y0), (x1, y1) = coords[j], coords[j + 1]
        ax, ay = curvature._to_local_xy(y0, x0, slat, slng)
        bx, by = curvature._to_local_xy(y1, x1, slat, slng)
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy
        t = 0.0 if l2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / l2))
        best = min(best, math.hypot(ax + t * dx, ay + t * dy))
    return best


def _projected_km(coords, cum, i, slat, slng, window=6):
    """Along-track km of a station's PERPENDICULAR projection onto the line.

    Distinct from `cum[nearest_vertex]`, and the distinction is VERIFIED #11 for
    the third time in this project.  Vertex spacing here is median ~195 m but
    runs to 11.9 km (VERIFIED #8), so a station inside a long span quantises to
    a vertex up to ~3 km away **along the track** even though it sits ~20 m from
    the line.  Measured on the 22229 reference against 12051's own coordinates:
    anchoring on the vertex gave along-track error median 342 m / max 3080 m
    (SNDD, inside an 11,923 m span); anchoring on the projection gives the
    numbers reported by `scripts/audit_corridor_points.py`.

    The vertex index is still what `block_geometry` returns — curvature needs an
    integer range and is unharmed by a vertex either way.  Only the km anchor,
    which is interpolated *between* anchors, needs the finer position.
    """
    best_km, best_d = None, math.inf
    for j in range(max(0, i - window), min(len(coords) - 1, i + window)):
        (x0, y0), (x1, y1) = coords[j], coords[j + 1]
        ax, ay = curvature._to_local_xy(y0, x0, slat, slng)
        bx, by = curvature._to_local_xy(y1, x1, slat, slng)
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy
        t = 0.0 if l2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / l2))
        d = math.hypot(ax + t * dx, ay + t * dy)
        if d < best_d:
            best_d = d
            best_km = cum[j] + t * (cum[j + 1] - cum[j])
    return best_km


def _snap_codes(coords, stations):
    """{code: vertex_index} by nearest vertex to each station's own lat/lng.

    Deliberately NOT forced monotonic.  `eta_model.snap_halts_to_vertices` forces
    monotonicity because it is building one train's ordered block boundaries and
    an inversion there would make a block negative-length.  This table is a
    lookup consumed in both directions — an up train reads the same codes in
    reverse — so each code is snapped independently and the caller sorts the
    pair it needs.

    O(stations x vertices) once per reference (82 x 1184 here), then memoised.
    """
    out, vtx_off, line_off = {}, [], []
    for s in stations:
        slat, slng = s["lat"], s["lng"]
        best_i, best_d = None, math.inf
        for i, (lng, lat) in enumerate(coords):
            d = curvature.haversine_m(slat, slng, lat, lng)
            if d < best_d:
                best_d, best_i = d, i
        if best_i is not None:
            out[s["stationCode"]] = best_i
            vtx_off.append(best_d)
            line_off.append(_perp_offset_m(coords, best_i, slat, slng))
    return out, vtx_off, line_off


def _build():
    """Discover and index every cached reference polyline."""
    refs = []
    for path in sorted(glob.glob(os.path.join(CACHE, "*_route.json"))):
        train = os.path.basename(path).replace("_route.json", "")
        try:
            coords = _route_coords(path)
        except (KeyError, TypeError, ValueError):
            continue
        stations, src = _reference_stations(train)
        if not stations or len(coords) < 3:
            # A route file with no matching coordinate-bearing live snapshot
            # cannot be anchored to station codes, so it is unusable here.  Kept
            # visible rather than skipped silently.
            refs.append({"train": train, "coords": coords, "codes": {},
                         "codeKm": {},
                         "unusable": "no coordinate-bearing live snapshot",
                         "stationSource": None,
                         "vertexOffsets": [], "lineOffsets": []})
            continue
        codes, vtx_off, line_off = _snap_codes(coords, stations)
        cum = [0.0]
        for (lng0, lat0), (lng1, lat1) in zip(coords[:-1], coords[1:]):
            cum.append(cum[-1] + curvature.haversine_m(lat0, lng0, lat1, lng1) / 1000.0)
        # Along-track km per code, from the perpendicular projection rather than
        # the snapped vertex.  See `_projected_km` — this is what removes the
        # 3 km along-track quantisation error at SNDD.
        by_code = {s["stationCode"]: s for s in stations}
        code_km = {}
        for c, vi in codes.items():
            s = by_code.get(c)
            if s is None:
                continue
            km = _projected_km(coords, cum, vi, s["lat"], s["lng"])
            if km is not None:
                code_km[c] = km
        on_axis = {c: axis.station_km(c) for c in codes
                   if axis.station_km(c) is not None}
        refs.append({
            "train": train,
            "coords": coords,
            "cumKm": cum,
            "codes": codes,
            "codeKm": code_km,
            "unusable": None,
            "stationSource": src,
            "vertexOffsets": vtx_off,
            "lineOffsets": line_off,
            "canonicalRangeKm": ([round(min(on_axis.values()), 1),
                                  round(max(on_axis.values()), 1)]
                                 if on_axis else None),
            "anchoredCodes": len(codes),
            "anchoredOnAxis": len(on_axis),
        })
    return refs


def references():
    global _refs
    if _refs is None:
        _refs = _build()
    return _refs


def available():
    return any(r["unusable"] is None and r["codes"] for r in references())


def block_geometry(code_a, code_b):
    """Geometry for one halt-to-halt block, or None.

    Returns `(coords, cumKm, i0, i1, ref_train)` with `i0 < i1` — sorted, so an
    up train reading the southbound reference in reverse gets the same range as
    the down train.  Curvature is direction-agnostic: a circumradius does not
    care which way the train is going.

    Picks the reference giving the widest vertex range for the pair, which is
    the one whose alignment actually covers the block rather than merely
    containing both codes at its own extremities.
    """
    best = None
    for r in references():
        if r["unusable"]:
            continue
        ia, ib = r["codes"].get(code_a), r["codes"].get(code_b)
        if ia is None or ib is None:
            continue
        i0, i1 = sorted((ia, ib))
        if i1 - i0 < 2:
            # Fewer than 3 vertices: a circumradius needs a 3-point window, so
            # there is no curvature to measure.  Not an error — a very short
            # block, or two codes snapped to adjacent vertices.
            continue
        if best is None or (i1 - i0) > (best[3] - best[2]):
            best = (r["coords"], r["cumKm"], i0, i1, r["train"])
    return best


def route_for(halts):
    """Per-block geometry for a whole train, keyed off its halt codes.

    `halts` is the train's ordered halt list (needs `stationCode` only — no
    coordinates, which the full-dataset trains do not have).

    Returns a dict whose `blocks` list is aligned 1:1 with the train's
    halt-to-halt segments: entry `k` is the geometry for `halts[k] -> halts[k+1]`,
    or None where that block has no resolvable alignment.
    """
    codes = [h.get("stationCode") for h in halts]
    blocks = [block_geometry(codes[k], codes[k + 1])
              for k in range(len(codes) - 1)]

    km_with = km_total = 0.0
    for k, (a, b) in enumerate(zip(halts[:-1], halts[1:])):
        d = (b.get("distance") or 0.0) - (a.get("distance") or 0.0)
        km_total += d
        if blocks[k] is not None:
            km_with += d

    resolved = sum(1 for b in blocks if b is not None)
    refs_used = sorted({b[4] for b in blocks if b is not None})

    missing = [f'{codes[k]}->{codes[k + 1]}'
               for k in range(len(blocks)) if blocks[k] is None]

    # An explicit reason per case, never a bare empty result (VERIFIED #9).  The
    # three cases need different answers from the reader: one is unfixable, one
    # needs a route file primed, one needs a code mapping.
    reason = None
    if not blocks:
        reason = ("this train has fewer than two halts on the corridor, so it "
                  "has no block to measure curvature over")
    elif resolved == 0:
        on_axis = [axis.station_km(c) for c in codes]
        on_axis = [k for k in on_axis if k is not None]
        spans = [r.get("canonicalRangeKm") for r in references()
                 if r.get("canonicalRangeKm")]
        if not on_axis:
            reason = ("no station of this train is on the canonical corridor "
                      "axis, so it cannot be matched to a cached polyline")
        elif spans and min(on_axis) >= max(s[1] for s in spans) - 0.05:
            # Entirely beyond the southern end of every cached polyline.  Names
            # the fix rather than describing the symptom.
            reason = (
                f"this train runs south of canonical km "
                f"{max(s[1] for s in spans):.1f} (Madgaon), beyond every cached "
                f"polyline; priming a southern route file "
                f"(scripts/prime_train.py 56615) resolves it with no code change"
            )
        else:
            reason = ("this train's stations are on the corridor axis but "
                      "outside every cached polyline's span")

    return {
        "basis": "shared-corridor-polyline" if resolved else None,
        "blocks": blocks,
        "referenceTrains": refs_used,
        "blocksResolved": resolved,
        "blocksTotal": len(blocks),
        "coverageKm": round(km_with, 1),
        "totalKm": round(km_total, 1),
        "coverageFraction": round(km_with / km_total, 4) if km_total else 0.0,
        "unresolvedBlocks": missing,
        "unavailableReason": reason,
        "basisNote": (
            "Curvature is computed on a cached polyline belonging to another "
            "train on the same physical alignment, clipped to this train's "
            "blocks by station code. It is the real Konkan alignment but NOT "
            "this train's own route file."
        ),
    }


_ANCHOR_CACHE = {}


def _anchor_table(ref):
    """[(canonical_km, along_track_km)] for one reference, sorted and deduped.

    Built from station codes that are BOTH anchored on this polyline and present
    on the canonical axis, so it is the bridge between "km from Roha" and "how
    far along this line".  Both columns are real distances — the along-track one
    comes from the perpendicular projection (`_projected_km`), never from a
    vertex index, which would quantise it by up to ~3 km here.

    Memoised per reference train: the corridor sweep resolves ~2,300 meets and
    rebuilding an 82-row sorted table for each would be the dominant cost.
    """
    hit = _ANCHOR_CACHE.get(ref["train"])
    if hit is not None:
        return hit
    tbl = []
    for code, along in ref.get("codeKm", {}).items():
        ckm = axis.station_km(code)
        if ckm is not None:
            tbl.append((ckm, along))
    tbl.sort()
    # Two codes can share a canonical km, and a repeated km would make the
    # interpolation below divide by zero.
    out = []
    for km, along in tbl:
        if out and abs(km - out[-1][0]) < 1e-9:
            continue
        out.append((km, along))
    _ANCHOR_CACHE[ref["train"]] = out
    return out


def _point_at_along_km(ref, target):
    """lat/lng at `target` km along a reference polyline."""
    cum, coords = ref["cumKm"], ref["coords"]
    lo, hi = 0, len(cum) - 1
    while lo < hi - 1:                       # binary search, not a linear walk
        mid = (lo + hi) // 2
        if cum[mid] <= target:
            lo = mid
        else:
            hi = mid
    seg = cum[lo + 1] - cum[lo]
    t = 0.0 if seg <= 0 else max(0.0, min(1.0, (target - cum[lo]) / seg))
    (lng0, lat0), (lng1, lat1) = coords[lo], coords[lo + 1]
    return lat0 + t * (lat1 - lat0), lng0 + t * (lng1 - lng0)


def point_at_corridor_km(corridor_km):
    """lat/lng for a point on the CANONICAL axis, or None if off every polyline.

    Why this exists: meet coordinates were interpolated from the reporting
    train's own station rows, and **0 of the 1859 full-dataset records carry
    station coordinates** — so only the handful of cache-backed trains could
    place a marker (measured: 41 of 2349 corridor meets, 1.7%).  The alignment
    is shared, though, so a canonical km can be resolved on a reference polyline
    exactly the way curvature is.

    Anchored between the two nearest station codes rather than by one global
    scale factor — the same correction VERIFIED #12 measures at median 655 m /
    max 1576 m on 22229, which is more than a typical Konkan tunnel.

    Returns `(lat, lng, ref_train)`.  Refuses to extrapolate beyond the anchor
    span: a km south of Madgaon has no cached polyline and must report
    unavailable rather than be pinned to the last vertex (VERIFIED #9).

    **Only sound on the single-line section.**  North of Roha the corridor's
    trains take physically different tracks — measured against 12051, whose
    Trans-Harbour approach diverges from the 22229 reference by up to 10.3 km at
    Nerul — so callers must gate on `corridor_axis.is_single_line`, which every
    conflict meet already satisfies.
    """
    if corridor_km is None:
        return None
    best = None
    for r in references():
        if r["unusable"] or not r.get("codeKm"):
            continue
        tbl = _anchor_table(r)
        if len(tbl) < 2 or not (tbl[0][0] <= corridor_km <= tbl[-1][0]):
            continue
        lo = max(i for i in range(len(tbl)) if tbl[i][0] <= corridor_km)
        hi = min(len(tbl) - 1, lo + 1)
        if hi == lo:
            lo = hi - 1
        (km0, a0), (km1, a1) = tbl[lo], tbl[hi]
        f = 0.0 if km1 == km0 else (corridor_km - km0) / (km1 - km0)
        lat, lng = _point_at_along_km(r, a0 + f * (a1 - a0))
        # Prefer the reference whose anchors bracket the point most tightly:
        # a narrower anchor gap is a smaller interpolation error.
        gap = abs(km1 - km0)
        if best is None or gap < best[0]:
            best = (gap, (lat, lng, r["train"]))
    return best[1] if best else None


def _nearest_on_polyline(coords, cum, lat, lng):
    """(along_track_km, offset_m) of the nearest POINT on a polyline — full scan.

    Distinct from `_projected_km`, which refines a position that is already snapped
    to a known vertex and so only has to search a ±6-vertex window.  A hazard
    report arrives as a bare lat/lng with no vertex hint, so the search has to be
    global.  1,184 vertices is a few milliseconds and this runs once per report,
    not once per vertex.

    Still a perpendicular projection with a clamped `t`, not a nearest-vertex
    snap — VERIFIED #11/#24 for the fourth surface in this project.
    """
    best_km, best_d = None, math.inf
    for j in range(len(coords) - 1):
        (x0, y0), (x1, y1) = coords[j], coords[j + 1]
        ax, ay = curvature._to_local_xy(y0, x0, lat, lng)
        bx, by = curvature._to_local_xy(y1, x1, lat, lng)
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy
        t = 0.0 if l2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / l2))
        d = math.hypot(ax + t * dx, ay + t * dy)
        if d < best_d:
            best_d = d
            best_km = cum[j] + t * (cum[j + 1] - cum[j])
    return best_km, best_d


def corridor_km_at_point(lat, lng, max_offset_m=2000.0):
    """Canonical corridor km for a lat/lng — the inverse of `point_at_corridor_km`.

    Obeys the same two rules as everything else that crosses between axes here:
    project PERPENDICULARLY onto the line rather than snapping to a vertex
    (VERIFIED #11/#24 — vertex spans reach 11.9 km on this route, so a point
    sitting 20 m from the alignment quantises up to ~3 km *along* it), and convert
    along-track km to canonical km ANCHORED between the two nearest station codes
    rather than by one global scale factor (VERIFIED #12, measured median 655 m /
    max 1576 m on 22229 — more than a typical Konkan tunnel).

    Returns `{corridorKm, offsetM, alongKm, referenceTrain, anchorGapKm}`, or None
    if the point is off every cached polyline or beyond its anchor span.
    `offsetM` travels with the km deliberately: a caller must never be able to
    treat a point 4 km from any track as though it were on the track.

    Refuses to extrapolate past the anchor span, for the same reason as
    `point_at_corridor_km` — a point south of Madgaon has no cached polyline, and
    pinning it to the last anchor would report a confident wrong km (VERIFIED #9).
    """
    if lat is None or lng is None:
        return None
    best = None
    for r in references():
        if r["unusable"] or not r.get("codeKm"):
            continue
        tbl = _anchor_table(r)
        if len(tbl) < 2:
            continue
        along, off = _nearest_on_polyline(r["coords"], r["cumKm"], lat, lng)
        if along is None or off > max_offset_m:
            continue

        # Invert the anchor table: along-track km → canonical km.  Sorted and
        # deduped on the *along* column this time, because that is the one being
        # interpolated on and a repeated value would divide by zero.
        inv = []
        for a, c in sorted((a, c) for c, a in tbl):
            if inv and abs(a - inv[-1][0]) < 1e-9:
                continue
            inv.append((a, c))
        if len(inv) < 2 or not (inv[0][0] <= along <= inv[-1][0]):
            continue

        lo = max(i for i in range(len(inv)) if inv[i][0] <= along)
        hi = min(len(inv) - 1, lo + 1)
        if hi == lo:
            lo = hi - 1
        (a0, c0), (a1, c1) = inv[lo], inv[hi]
        f = 0.0 if a1 == a0 else (along - a0) / (a1 - a0)
        gap = abs(a1 - a0)

        # Closest alignment first, then the tighter anchor bracket.  Offset leads
        # because a point 20 m from one polyline and 3 km from another is
        # unambiguously on the first, whatever the anchor spacing says.
        key = (round(off, 1), gap)
        if best is None or key < best[0]:
            best = (key, {
                "corridorKm": c0 + f * (c1 - c0),
                "offsetM": off,
                "alongKm": along,
                "referenceTrain": r["train"],
                "anchorGapKm": round(gap, 1),
            })
    return best[1] if best else None


def audit():
    """Summarise every discovered reference. Used by the CLI and diagnostics."""
    def _stats(vals):
        if not vals:
            return (None, None)
        s = sorted(vals)
        return (round(s[len(s) // 2], 1), round(s[-1], 1))

    out = []
    for r in references():
        vm, vx = _stats(r.get("vertexOffsets") or [])
        lm, lx = _stats(r.get("lineOffsets") or [])
        line_off = r.get("lineOffsets") or []
        out.append({
            "train": r["train"],
            "vertices": len(r["coords"]),
            "unusable": r["unusable"],
            "stationSource": r["stationSource"],
            "anchoredCodes": r.get("anchoredCodes", 0),
            "anchoredOnAxis": r.get("anchoredOnAxis", 0),
            "canonicalRangeKm": r.get("canonicalRangeKm"),
            # Two different measurements; see _perp_offset_m.  The LINE figure
            # is the one that says whether the anchoring is sound.
            "toVertexMedianM": vm, "toVertexMaxM": vx,
            "toLineMedianM": lm, "toLineMaxM": lx,
            "stationsOver800mFromLine": sum(1 for d in line_off if d > 800),
        })
    return out


if __name__ == "__main__":
    import sys
    rows = audit()
    if not rows:
        print("no *_route.json in .cache/ — curvature has no shared polyline")
        sys.exit(1)
    print("reference polylines discovered in .cache/")
    for r in rows:
        print(f"  {r['train']}  {r['vertices']:>5} vertices  "
              f"anchors {r['anchoredCodes']:>3} codes "
              f"({r['anchoredOnAxis']} on canonical axis)")
        print(f"          canonical km {r['canonicalRangeKm']}   "
              f"[{r['stationSource']}]")
        print(f"          station -> nearest VERTEX: median "
              f"{r['toVertexMedianM']} m / max {r['toVertexMaxM']} m "
              f"(quantisation, VERIFIED #8/#11)")
        print(f"          station -> nearest LINE  : median "
              f"{r['toLineMedianM']} m / max {r['toLineMaxM']} m "
              f"-> {r['stationsOver800mFromLine']} station(s) genuinely "
              f">800 m off the alignment")
        if r["unusable"]:
            print(f"          UNUSABLE: {r['unusable']}")
    sys.exit(0)
