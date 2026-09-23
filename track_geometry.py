"""
track_geometry.py — High-Resolution Track Geometry & Densification

Provides mathematical tools to transform sparse railway polylines into
high-resolution, continuous track alignments suitable for precise curvature
speed-capping (RDSO broad-gauge rules).

Background:
Raw GPS/survey polylines from crowdsourced APIs often contain long chords
between distant vertices (up to 11.9 km on Konkan Railway). Because a 3-point
Menger circumcircle calculation cannot resolve any curve shorter than its
chord length, sparse spans render 28% to 56% of the track curvature-blind.

This module applies centripetal Catmull-Rom spline interpolation parameterized
by chord length to resample sparse spans to a uniform resolution (e.g. <= 100 m)
while preserving exact original survey vertices.
"""

import math
import curvature

EARTH_RADIUS_M = 6371000.0


def _haversine_distance(p1, p2):
    """Distance in metres between [lng, lat] pairs (GeoJSON order)."""
    lng1, lat1 = p1
    lng2, lat2 = p2
    return curvature.haversine_m(lat1, lng1, lat2, lng2)


def _to_projected(lat, lng, ref_lat, ref_lng):
    """Local equirectangular x, y in metres."""
    x = math.radians(lng - ref_lng) * EARTH_RADIUS_M * math.cos(math.radians(ref_lat))
    y = math.radians(lat - ref_lat) * EARTH_RADIUS_M
    return x, y


def _to_geographic(x, y, ref_lat, ref_lng):
    """Convert local equirectangular x, y in metres back to [lng, lat]."""
    lat = ref_lat + (y / EARTH_RADIUS_M) * (180.0 / math.pi)
    lng = ref_lng + (x / (EARTH_RADIUS_M * math.cos(math.radians(ref_lat)))) * (180.0 / math.pi)
    return [round(lng, 6), round(lat, 6)]


def catmull_rom_interpolate(p0, p1, p2, p3, n_steps, alpha=0.5):
    """
    Interpolates between p1 and p2 using Centripetal Catmull-Rom spline.
    alpha=0.5 ensures centripetal parameterization (avoids cusps/overshoot).
    p0, p1, p2, p3 are (x, y) coordinates in local metres.
    Returns list of (x, y) coordinates (excluding p1, including intermediate steps and p2).
    """
    def get_t(t_prev, pa, pb):
        d = math.hypot(pb[0] - pa[0], pb[1] - pa[1])
        return t_prev + (d ** alpha if d > 1e-9 else 1e-9)

    t0 = 0.0
    t1 = get_t(t0, p0, p1)
    t2 = get_t(t1, p1, p2)
    t3 = get_t(t2, p2, p3)

    result = []
    for step in range(1, n_steps + 1):
        t = t1 + (t2 - t1) * (step / n_steps)
        a1 = [(t1 - t) / (t1 - t0) * p0[k] + (t - t0) / (t1 - t0) * p1[k] for k in (0, 1)]
        a2 = [(t2 - t) / (t2 - t1) * p1[k] + (t - t1) / (t2 - t1) * p2[k] for k in (0, 1)]
        a3 = [(t3 - t) / (t3 - t2) * p2[k] + (t - t2) / (t3 - t2) * p3[k] for k in (0, 1)]

        b1 = [(t2 - t) / (t2 - t0) * a1[k] + (t - t0) / (t2 - t0) * a2[k] for k in (0, 1)]
        b2 = [(t3 - t) / (t3 - t1) * a2[k] + (t - t1) / (t3 - t1) * a3[k] for k in (0, 1)]

        c = [(t2 - t) / (t2 - t1) * b1[k] + (t - t1) / (t2 - t1) * b2[k] for k in (0, 1)]
        result.append((c[0], c[1]))

    return result


def densify_track(coords, max_step_m=100.0, use_spline=True):
    """
    Densifies a polyline of [lng, lat] pairs so that no two consecutive
    vertices are more than max_step_m apart.

    Args:
        coords: List of [lng, lat] pairs (GeoJSON standard).
        max_step_m: Maximum permissible distance between consecutive vertices (default 100m).
        use_spline: If True, uses centripetal Catmull-Rom spline on curved spans.
                   If False, uses linear/geodesic interpolation.

    Returns:
        High-resolution list of [lng, lat] pairs.
    """
    n = len(coords)
    if n < 2:
        return list(coords)

    ref_lng, ref_lat = coords[0]
    # Convert all coordinates to local planar meters for smooth spline computation
    local_xy = [_to_projected(lat, lng, ref_lat, ref_lng) for lng, lat in coords]

    densified_xy = [local_xy[0]]

    for i in range(n - 1):
        p1 = local_xy[i]
        p2 = local_xy[i + 1]

        # Context points for Catmull-Rom
        p0 = local_xy[i - 1] if i > 0 else (2 * p1[0] - p2[0], 2 * p1[1] - p2[1])
        p3 = local_xy[i + 2] if i + 2 < n else (2 * p2[0] - p1[0], 2 * p2[1] - p1[1])

        span_dist = math.hypot(p2[0] - p1[0], p2[1] - p1[1])

        if span_dist > max_step_m:
            n_steps = int(math.ceil(span_dist / max_step_m))
            if use_spline and n >= 4:
                interp_points = catmull_rom_interpolate(p0, p1, p2, p3, n_steps)
                densified_xy.extend(interp_points)
            else:
                # Linear fallback
                for step in range(1, n_steps + 1):
                    t = step / n_steps
                    densified_xy.append((
                        p1[0] + t * (p2[0] - p1[0]),
                        p1[1] + t * (p2[1] - p1[1]),
                    ))
        else:
            densified_xy.append(p2)

    # Convert back to geographic [lng, lat]
    return [_to_geographic(x, y, ref_lat, ref_lng) for x, y in densified_xy]


def analyze_resolution(coords, threshold_km=1.0):
    """
    Computes diagnostic metrics for a track polyline.
    Returns dictionary of spacing stats, blind distance, and resolvable percentage.
    """
    n = len(coords)
    if n < 2:
        return {}

    spacings_m = []
    total_m = 0.0

    for i in range(n - 1):
        d_m = _haversine_distance(coords[i], coords[i + 1])
        spacings_m.append(d_m)
        total_m += d_m

    sorted_sp = sorted(spacings_m)
    total_km = total_m / 1000.0
    threshold_m = threshold_km * 1000.0

    blind_m = sum(d for d in spacings_m if d > threshold_m)
    blind_km = blind_m / 1000.0
    blind_pct = (blind_km / total_km * 100.0) if total_km > 0 else 0.0

    return {
        "vertices": n,
        "total_km": round(total_km, 2),
        "spacing_m": {
            "min": round(sorted_sp[0], 1),
            "median": round(sorted_sp[len(sorted_sp) // 2], 1),
            "p75": round(sorted_sp[int(0.75 * len(sorted_sp))], 1),
            "max": round(sorted_sp[-1], 1),
        },
        "blind_threshold_km": threshold_km,
        "spans_over_threshold": sum(1 for d in spacings_m if d > threshold_m),
        "curvature_blind_km": round(blind_km, 2),
        "curvature_blind_pct": round(blind_pct, 1),
        "resolvable_pct": round(100.0 - blind_pct, 1),
    }
