#!/usr/bin/env python3
"""
scripts/build_hires_geometry.py — Generate high-resolution track geometry.

OFFLINE & CACHE-ONLY:
Reads existing `{train}_route.json` from `.cache/` and produces `{train}_route_hires.json`.
Applies spline densification so that no vertex span exceeds 100 metres, eliminating
curvature-blind spans and increasing resolvable coverage to 100%.

Usage:
    python3 scripts/build_hires_geometry.py
"""

import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(ROOT, ".cache")

sys.path.insert(0, ROOT)

import track_geometry


def process_route_file(path, max_step_m=100.0):
    filename = os.path.basename(path)
    train = filename.replace("_route.json", "")

    with open(path, "r") as f:
        data = json.load(f)

    # Handle GeoJSON coordinates extraction
    if "geojson" in data and "geometry" in data["geojson"]:
        raw_coords = data["geojson"]["geometry"]["coordinates"]
    elif "geometry" in data and "coordinates" in data["geometry"]:
        raw_coords = data["geometry"]["coordinates"]
    elif "coordinates" in data:
        raw_coords = data["coordinates"]
    else:
        print(f"  [SKIP] {filename}: Unknown coordinates structure")
        return None

    raw_res = track_geometry.analyze_resolution(raw_coords)
    hires_coords = track_geometry.densify_track(raw_coords, max_step_m=max_step_m, use_spline=True)
    hires_res = track_geometry.analyze_resolution(hires_coords)

    diff_km = hires_res["total_km"] - raw_res["total_km"]
    diff_pct = (abs(diff_km) / raw_res["total_km"] * 100.0) if raw_res["total_km"] > 0 else 0.0

    hires_payload = {
        "success": True,
        "data": {
            "trainNumber": train,
            "format": "geojson",
            "resolution": "high_res",
            "metadata": {
                "max_step_m": max_step_m,
                "raw_vertices": raw_res["vertices"],
                "hires_vertices": hires_res["vertices"],
                "raw_resolvable_pct": raw_res["resolvable_pct"],
                "hires_resolvable_pct": hires_res["resolvable_pct"],
                "raw_blind_km": raw_res["curvature_blind_km"],
                "hires_blind_km": hires_res["curvature_blind_km"],
                "length_diff_pct": round(diff_pct, 4),
            },
            "geojson": {
                "type": "Feature",
                "properties": {
                    "trainNumber": train,
                    "resolution": "high_res",
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": hires_coords,
                },
            },
        },
    }

    out_path = os.path.join(CACHE, f"{train}_route_hires.json")
    with open(out_path, "w") as f:
        json.dump(hires_payload, f, indent=2)

    return {
        "train": train,
        "out_path": out_path,
        "raw": raw_res,
        "hires": hires_res,
        "diff_pct": diff_pct,
    }


def main():
    print("=" * 78)
    print("GATI — High-Resolution Track Geometry Generator")
    print("=" * 78)

    targets = sorted(glob.glob(os.path.join(CACHE, "*_route.json")))
    if not targets:
        print(f"No *_route.json files found in {CACHE}")
        return

    print(f"Found {len(targets)} route files in {CACHE}:\n")

    results = []
    for path in targets:
        res = process_route_file(path)
        if res:
            results.append(res)

    print(f"{'Train':<8} {'Raw Vtx':<10} {'Hires Vtx':<10} {'Raw Blind':<12} {'Hires Blind':<12} {'Coverage':<12} {'Len Diff':<10}")
    print("-" * 78)
    for r in results:
        train = r["train"]
        raw_v = r["raw"]["vertices"]
        hi_v = r["hires"]["vertices"]
        raw_b = f"{r['raw']['curvature_blind_km']} km"
        hi_b = f"{r['hires']['curvature_blind_km']} km"
        cov = f"{r['raw']['resolvable_pct']}% -> {r['hires']['resolvable_pct']}%"
        diff = f"{r['diff_pct']:.3f}%"
        print(f"{train:<8} {raw_v:<10} {hi_v:<10} {raw_b:<12} {hi_b:<12} {cov:<12} {diff:<10}")

    print("-" * 78)
    print(f"Generated {len(results)} high-resolution route files in .cache/")


if __name__ == "__main__":
    main()
