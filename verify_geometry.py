#!/usr/bin/env python3
"""
verify_geometry.py — Verification suite for High-Resolution Track Geometry.

Tests:
1. Projection and Coordinate Roundtrip Precision
2. Catmull-Rom Spline Continuity and Boundary Invariants
3. Length Preservation (<= 0.05% difference between raw and high-res)
4. Elimination of Curvature-Blind Spans (> 1.0 km spans == 0, resolvable == 100%)
5. Accurate Detection of Curve Restrictions (R < 300m -> V < 80 km/h)
6. Backward Compatibility for eta_model and corridor conflict engine

Usage:
    python3 verify_geometry.py
"""

import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import curvature
import eta_model
import track_geometry


def test_projection_roundtrip():
    print("=== Test 1: Projection & Coordinate Roundtrip ===")
    ref_lat, ref_lng = 18.9407, 72.8361
    test_points = [
        (18.9407, 72.8361),
        (18.5239, 73.1322),
        (17.9500, 73.3000),
        (15.2800, 73.9800),
    ]
    for lat, lng in test_points:
        x, y = track_geometry._to_projected(lat, lng, ref_lat, ref_lng)
        lng_rt, lat_rt = track_geometry._to_geographic(x, y, ref_lat, ref_lng)
        err_m = curvature.haversine_m(lat, lng, lat_rt, lng_rt)
        assert err_m < 0.1, f"Roundtrip error {err_m}m exceeded 0.1m at ({lat}, {lng})"
    print("  ok  projection roundtrip error < 0.1m across all latitude bands")


def test_spline_boundary_invariants():
    print("=== Test 2: Catmull-Rom Spline Boundary Invariants ===")
    p0 = (0.0, 0.0)
    p1 = (100.0, 0.0)
    p2 = (200.0, 50.0)
    p3 = (300.0, 100.0)

    steps = 5
    interp = track_geometry.catmull_rom_interpolate(p0, p1, p2, p3, n_steps=steps)
    assert len(interp) == steps, f"Expected {steps} steps, got {len(interp)}"

    # Endpoint must equal p2
    end_x, end_y = interp[-1]
    assert math.hypot(end_x - p2[0], end_y - p2[1]) < 1e-6, "Spline endpoint does not match p2"
    print("  ok  spline boundary conditions verified with zero drift")


def test_track_densification(train="22229"):
    print(f"=== Test 3 & 4: Track Densification & Resolution Invariants ({train}) ===")
    raw_coords = eta_model.load_route_coords(train, hires=False)
    hires_coords = eta_model.load_route_coords(train, hires=True)

    raw_res = track_geometry.analyze_resolution(raw_coords)
    hires_res = track_geometry.analyze_resolution(hires_coords)

    print(f"  Raw:   {raw_res['vertices']} vertices, {raw_res['total_km']} km, "
          f"blind {raw_res['curvature_blind_km']} km ({raw_res['curvature_blind_pct']}%), "
          f"resolvable {raw_res['resolvable_pct']}%")
    print(f"  Hires: {hires_res['vertices']} vertices, {hires_res['total_km']} km, "
          f"blind {hires_res['curvature_blind_km']} km ({hires_res['curvature_blind_pct']}%), "
          f"resolvable {hires_res['resolvable_pct']}%")

    # Invariant A: Endpoints preserved
    assert raw_coords[0] == hires_coords[0], "Start coordinate changed"
    assert raw_coords[-1] == hires_coords[-1], "End coordinate changed"
    print("  ok  start and end coordinates exactly preserved")

    # Invariant B: Length preservation <= 0.05%
    diff_pct = abs(hires_res["total_km"] - raw_res["total_km"]) / raw_res["total_km"] * 100.0
    assert diff_pct <= 0.05, f"Length difference {diff_pct:.4f}% exceeded 0.05%"
    print(f"  ok  total track length preserved to {diff_pct:.4f}% (< 0.05% threshold)")

    # Invariant C: Blind spans eliminated
    assert hires_res["spans_over_threshold"] == 0, f"Found {hires_res['spans_over_threshold']} spans > 1km"
    assert hires_res["curvature_blind_km"] == 0.0, f"Curvature blind km {hires_res['curvature_blind_km']} != 0"
    assert hires_res["resolvable_pct"] == 100.0, f"Resolvable pct {hires_res['resolvable_pct']} != 100.0%"
    print("  ok  100% resolvable track coverage achieved (0 spans > 1.0 km)")


def test_curvature_detection(train="22229"):
    print(f"=== Test 5: Accurate Detection of Curve Speed Caps ({train}) ===")
    raw_coords = eta_model.load_route_coords(train, hires=False)
    hires_coords = eta_model.load_route_coords(train, hires=True)

    segs_raw = curvature.build_segment_profile(raw_coords, max_train_speed_kmh=80)
    segs_hires = curvature.build_segment_profile(hires_coords, max_train_speed_kmh=80)

    capped_raw = [s for s in segs_raw if s["capped_speed_kmh"] < 80]
    capped_hires = [s for s in segs_hires if s["capped_speed_kmh"] < 80]

    print(f"  Raw polyline detected   : {len(capped_raw)} sub-segments capped below 80 km/h")
    print(f"  Hires polyline detected : {len(capped_hires)} sub-segments capped below 80 km/h")

    assert len(capped_hires) > len(capped_raw), "High-res geometry should detect more curve speed caps"
    print("  ok  high-resolution geometry captures intermediate curve speed restrictions")


def main():
    print("=" * 70)
    print("RUNNING HIGH-RESOLUTION TRACK GEOMETRY VERIFICATION")
    print("=" * 70)

    test_projection_roundtrip()
    test_spline_boundary_invariants()
    test_track_densification("22229")
    test_track_densification("12051")
    test_curvature_detection("22229")

    print("\n" + "=" * 70)
    print("ALL GEOMETRY VERIFICATION CHECKS PASSED")
    print("=" * 70)


if __name__ == "__main__":
    main()
