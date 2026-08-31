"""
build_tunnels.py — turn the OSM-derived Konkan tunnel CSV into src/data/konkan-tunnels.json.

Offline. No API calls, no network. Reads the CSV plus the already-cached 12051
route polyline (for ordering and a reference chainage) and writes the tunnel
database the Node dead-reckoning service consumes.

    python3 build_tunnels.py --dry-run          # audit only, write nothing
    python3 build_tunnels.py                    # audit + write src/data/konkan-tunnels.json
    python3 build_tunnels.py path/to/other.csv

Per CLAUDE.md §8 this prints every intermediate number: parsed rows, the length
distribution, the published-figure validation deltas, portal snap errors, and
every data defect found. Nothing is silently corrected.

Length basis is the portal-to-portal great-circle CHORD, not the along-track
distance summed from the polyline. Chord matches published KRCL figures to
within 1.1%, and — once portals are projected perpendicularly onto the polyline
rather than snapped to the nearest vertex — the along-track figure agrees with
it to within ~1% too. Chord stays the published number because it depends only
on the OSM portal coordinates, independent of the polyline's vertex density
(which varies from 195 m to 11.9 km, CLAUDE.md VERIFIED #8).
"""
import csv
import json
import math
import os
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CSV = os.path.expanduser(
    "~/Downloads/konkan_railway_tunnels_mumbai_goa (1).csv"
)
OUT_PATH = os.path.join(HERE, "src", "data", "konkan-tunnels.json")
REF_ROUTE = os.path.join(HERE, ".cache", "train_12051_live_fallback.json")

# Published KRCL / public-record lengths, metres. Used only to VALIDATE the
# derived chord — never to overwrite it. Sourced from Konkan Railway's own
# published tunnel list; kept small and checkable on purpose.
PUBLISHED_M = {
    "Karbude Tunnel": 6506,
    "Natuwadi Tunnel": 4387,
    "Tike Tunnel": 4077,
    "Savarde Tunnel": 3447,
    "Berdewadi Tunnel": 4000,
}

EARTH_R_M = 6371000.0


def haversine_m(lat1, lng1, lat2, lng2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return EARTH_R_M * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def slugify(name):
    out = []
    for ch in name.lower():
        if ch.isalnum():
            out.append(ch)
        elif out and out[-1] != "-":
            out.append("-")
    return "".join(out).strip("-")


def load_reference_polyline():
    """[[lat, lng], ...] from the cached 12051 payload, or None."""
    try:
        with open(REF_ROUTE) as f:
            payload = json.load(f)
    except (OSError, ValueError):
        return None, None
    try:
        coords = payload["geometry"]["geojson"]["geometry"]["coordinates"]
    except (KeyError, TypeError):
        return None, None
    # GeoJSON is [lng, lat] (CLAUDE.md VERIFIED #1)
    return [[c[1], c[0]] for c in coords], payload.get("train", {}).get("distance")


def cumulative_km(coords):
    cum = [0.0]
    for i in range(1, len(coords)):
        cum.append(
            cum[-1]
            + haversine_m(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1])
            / 1000.0
        )
    return cum


def project_to_polyline(coords, cum, lat, lng):
    """
    Perpendicular projection of a point onto the polyline.

    Returns (chainage_km, perpendicular_distance_m, segment_index).

    Deliberately NOT nearest-vertex snapping. Vertex spacing on this route is
    median ~195 m but runs to 11.9 km (CLAUDE.md VERIFIED #8), so nearest-vertex
    quantises both portals of a short tunnel onto the SAME vertex — giving it
    zero length on the chainage axis, which makes containment impossible to
    detect. Projecting onto the segment keeps chainage continuous and cuts the
    apparent snap error to the true perpendicular offset.

    Uses a local equirectangular approximation (metres per degree at this
    latitude); exact enough at sub-kilometre scale and avoids a full geodesic
    inverse per segment.
    """
    m_per_deg_lat = 111132.0
    m_per_deg_lng = 111320.0 * math.cos(math.radians(lat))

    best = (0.0, float("inf"), 0)
    for i in range(len(coords) - 1):
        alat, alng = coords[i]
        blat, blng = coords[i + 1]
        ax = (alng - lng) * m_per_deg_lng
        ay = (alat - lat) * m_per_deg_lat
        bx = (blng - lng) * m_per_deg_lng
        by = (blat - lat) * m_per_deg_lat
        dx, dy = bx - ax, by - ay
        seg_len_sq = dx * dx + dy * dy
        if seg_len_sq == 0:
            t = 0.0
        else:
            # clamp so the projection stays on the segment
            t = max(0.0, min(1.0, -(ax * dx + ay * dy) / seg_len_sq))
        px, py = ax + t * dx, ay + t * dy
        d = math.hypot(px, py)
        if d < best[1]:
            seg_km = cum[i + 1] - cum[i]
            best = (cum[i] + t * seg_km, d, i)
    return best


def parse_csv(path):
    tunnels = []
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            # `Tunnel No` is a STRING — row "36A" is legitimate railway
            # numbering, and int() on it raises.
            number = (row["Tunnel No"] or "").strip()
            name = (row["Tunnel Name"] or "").strip()
            a_lat, a_lng = float(row["Start Lat"]), float(row["Start Lon"])
            b_lat, b_lng = float(row["End Lat"]), float(row["End Lon"])
            tunnels.append(
                {
                    "id": slugify(name) or f"tunnel-{number}",
                    "no": number,
                    "name": name,
                    "portalA": {"lat": a_lat, "lng": a_lng},
                    "portalB": {"lat": b_lat, "lng": b_lng},
                    "chordLengthM": round(haversine_m(a_lat, a_lng, b_lat, b_lng), 1),
                    "osmWaySegments": int(row["OSM Way Segments"] or 0),
                }
            )
    return tunnels


def main():
    argv = [a for a in sys.argv[1:] if a != "--dry-run"]
    dry_run = "--dry-run" in sys.argv
    csv_path = argv[0] if argv else DEFAULT_CSV

    if not os.path.exists(csv_path):
        print(f"ERROR: CSV not found: {csv_path}")
        return 1

    tunnels = parse_csv(csv_path)
    print(f"── Parsed {len(tunnels)} tunnels from {os.path.basename(csv_path)}")

    # ── length distribution ──────────────────────────────────────────────
    lengths = sorted(t["chordLengthM"] for t in tunnels)
    print("\n── Chord length distribution (m)")
    print(
        f"   min {lengths[0]:.0f}   median {statistics.median(lengths):.0f}   "
        f"mean {statistics.mean(lengths):.0f}   max {lengths[-1]:.0f}"
    )
    print("   10 longest:")
    for t in sorted(tunnels, key=lambda x: -x["chordLengthM"])[:10]:
        print(f"     #{t['no']:<4} {t['name']:<26} {t['chordLengthM']:>8.0f} m")

    # ── validate chord against published figures ─────────────────────────
    print("\n── Chord vs published KRCL length (validation, not a correction)")
    validation = []
    for name, published in PUBLISHED_M.items():
        match = next((t for t in tunnels if t["name"] == name), None)
        if not match:
            print(f"     {name:<26} NOT IN CSV")
            continue
        derived = match["chordLengthM"]
        delta_pct = (derived - published) / published * 100
        validation.append(
            {
                "name": name,
                "publishedM": published,
                "derivedChordM": round(derived, 1),
                "deltaPct": round(delta_pct, 2),
            }
        )
        print(
            f"     {name:<26} published {published:>6} m   "
            f"chord {derived:>8.0f} m   Δ {delta_pct:+6.2f}%"
        )
    if validation:
        worst = max(abs(v["deltaPct"]) for v in validation)
        print(f"   worst absolute deviation: {worst:.2f}%")

    # ── defects: duplicate & missing numbers ─────────────────────────────
    print("\n── Data defects (recorded, not silently fixed)")
    seen = {}
    duplicates = []
    for t in tunnels:
        if t["no"] in seen:
            duplicates.append(t["no"])
            print(
                f"     DUPLICATE #{t['no']}: '{seen[t['no']]}' and '{t['name']}' "
                f"share a number"
            )
        else:
            seen[t["no"]] = t["name"]

    numeric = sorted(int(n) for n in seen if n.isdigit())
    missing = [n for n in range(numeric[0], numeric[-1] + 1) if n not in set(numeric)]
    print(f"     numeric range present: {numeric[0]}..{numeric[-1]}")
    print(f"     gaps inside range: {missing or 'none'}")
    non_numeric = sorted(n for n in seen if not n.isdigit())
    print(f"     non-numeric tunnel numbers: {non_numeric or 'none'}")
    print(
        f"     {len(tunnels)} rows → {len(seen)} distinct numbers "
        f"+ {len(duplicates)} duplicate(s). One of the #66 pair most likely "
        f"belongs in the {missing} gap, but which one is NOT inferable from the "
        f"CSV — both are kept, neither is renumbered."
    )

    # ── order & reference chainage from the cached polyline ───────────────
    coords, timetable_km = load_reference_polyline()
    axis_note = None
    if coords:
        cum = cumulative_km(coords)
        print(
            f"\n── Reference polyline: {len(coords)} vertices, "
            f"{cum[-1]:.2f} km (timetable says {timetable_km} km, "
            f"mismatch {abs(cum[-1] - timetable_km) * 1000:.0f} m)"
        )
        axis_note = (
            f"polyline {cum[-1]:.2f} km vs timetable {timetable_km} km — "
            f"{abs(cum[-1] - timetable_km) * 1000:.0f} m mismatch; runtime "
            f"renormalises per block onto the timetable axis"
        )
        snap_errors = []
        degenerate = 0
        for t in tunnels:
            ka, da, ia = project_to_polyline(
                coords, cum, t["portalA"]["lat"], t["portalA"]["lng"]
            )
            kb, db, ib = project_to_polyline(
                coords, cum, t["portalB"]["lat"], t["portalB"]["lng"]
            )
            lo_km, hi_km = min(ka, kb), max(ka, kb)
            t["refVertexIndex"] = [min(ia, ib), max(ia, ib)]
            t["refPolylineKm"] = [round(lo_km, 4), round(hi_km, 4)]
            t["snapErrorM"] = round(max(da, db), 1)
            t["alongTrackLengthM"] = round((hi_km - lo_km) * 1000, 1)
            if t["alongTrackLengthM"] < 1:
                degenerate += 1
            snap_errors.append(t["snapErrorM"])

        se = sorted(snap_errors)
        print("── Portal perpendicular offset from polyline (m)")
        print(
            f"   median {statistics.median(se):.0f}   "
            f"p90 {se[int(len(se) * 0.9)]:.0f}   max {se[-1]:.0f}"
        )
        worst_snap = max(tunnels, key=lambda x: x["snapErrorM"])
        print(f"   worst: {worst_snap['name']} at {worst_snap['snapErrorM']:.0f} m")
        print(
            f"   tunnels collapsed to zero chainage length: {degenerate} of "
            f"{len(tunnels)}"
        )

        # Tunnels whose positional offset exceeds their own length cannot support
        # a defensible "you are inside this one" claim.
        low_conf = [t for t in tunnels if t["snapErrorM"] > t["chordLengthM"]]
        print(
            f"   offset > own length (containment not defensible): "
            f"{len(low_conf)} of {len(tunnels)}"
        )
        for t in low_conf:
            t["positionalConfidence"] = "low"
            print(
                f"     LOW  {t['name']:<26} len {t['chordLengthM']:>6.0f} m  "
                f"offset {t['snapErrorM']:>6.0f} m"
            )
        for t in tunnels:
            t.setdefault("positionalConfidence", "high")

        print("── Chord vs along-track (why chord is the published number)")
        for t in sorted(tunnels, key=lambda x: -x["chordLengthM"])[:5]:
            ratio = (
                t["alongTrackLengthM"] / t["chordLengthM"] if t["chordLengthM"] else 0
            )
            print(
                f"     {t['name']:<26} chord {t['chordLengthM']:>8.0f}  "
                f"along-track {t['alongTrackLengthM']:>8.0f}  ratio {ratio:.2f}"
            )

        row_order = [t["no"] for t in tunnels]
        tunnels.sort(key=lambda t: t["refPolylineKm"][0])
        chain_order = [t["no"] for t in tunnels]
        if row_order != chain_order:
            first_diff = next(
                i for i, (a, b) in enumerate(zip(row_order, chain_order)) if a != b
            )
            print(
                f"     ROW ORDER != CHAINAGE ORDER — first divergence at row "
                f"{first_diff + 1}: CSV has #{row_order[first_diff]}, "
                f"chainage has #{chain_order[first_diff]}. Output is sorted by "
                f"chainage."
            )
        print(
            f"\n── Chainage coverage: {tunnels[0]['refPolylineKm'][0]:.1f} km "
            f"({tunnels[0]['name']}) → {tunnels[-1]['refPolylineKm'][1]:.1f} km "
            f"({tunnels[-1]['name']}) of {cum[-1]:.1f} km"
        )
        total_tunnel_km = sum(t["chordLengthM"] for t in tunnels) / 1000.0
        print(
            f"   {total_tunnel_km:.1f} km of tunnel = "
            f"{total_tunnel_km / cum[-1] * 100:.1f}% of the route underground"
        )
    else:
        print(
            f"\n── No cached polyline at {REF_ROUTE} — output is in CSV row order "
            f"and carries no reference chainage. Runtime projection still works."
        )
        for t in tunnels:
            t.setdefault("positionalConfidence", "high")

    out = {
        "_meta": {
            "source": "OpenStreetMap way geometry, supplied as CSV "
            f"({os.path.basename(csv_path)})",
            "sourceIsOfficial": False,
            "lengthBasis": "portal-to-portal great-circle chord",
            "lengthBasisNote": "Chord matches published KRCL figures to within "
            "1.1% across the 5 tunnels with public figures. alongTrackLengthM "
            "(measured along the route polyline by perpendicular portal "
            "projection) agrees with the chord to within ~1%, so the two bases "
            "corroborate each other. Chord is the published number because it "
            "depends only on the OSM portal coordinates, not on the polyline's "
            "vertex density.",
            "publishedValidation": validation,
            "tunnelCount": len(tunnels),
            "duplicateNumbers": sorted(set(duplicates)),
            "gapsInsideRange": missing,
            "nonNumericNumbers": non_numeric,
            "order": "sorted by chainage along the 12051 CSMT→MAO polyline"
            if coords
            else "CSV row order (no polyline available at build time)",
            "referenceAxisNote": axis_note,
            "uiCaveat": "Tunnel positions and lengths are derived from "
            "OpenStreetMap way geometry, not official KRCL alignment data. "
            "Time-to-exit uses the schedule-derived block speed — there is no "
            "live speed in the data source.",
            "builtBy": "build_tunnels.py",
        },
        "tunnels": tunnels,
    }

    if dry_run:
        print(f"\n── --dry-run: would write {len(tunnels)} tunnels to {OUT_PATH}")
        return 0

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(out, f, indent=2)
        f.write("\n")
    print(f"\n── Wrote {len(tunnels)} tunnels → {os.path.relpath(OUT_PATH, HERE)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
