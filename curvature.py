"""
Curvature & Weather-Aware Speed Capping — Phase 2
This is the core USP module: turns a GeoJSON route into a list of
segments, each with its own physically-achievable speed (capped by
curve radius, then further capped by weather), instead of one
average speed for the whole journey.

Formula used: V (km/h) = 4.58 * sqrt(R)  [R in metres]
This is the standard Indian Railways curve-speed relationship for
broad-gauge track (RDSO permissible-speed-on-curve guidance, BG,
normal cant + cant deficiency). Treat the constant as configurable —
real deployment would use RDSO's exact cant/superelevation table per
train type, but this gives a physically grounded approximation.
"""

import math

EARTH_RADIUS_M = 6371000
CURVE_SPEED_CONSTANT = 4.58  # km/h per sqrt(metre) -- BG, normal cant (approx.)

# Weather multipliers applied on top of the curve-capped speed.
# These are placeholder values -- tune with real monsoon/fog TSR data.
WEATHER_SPEED_FACTOR = {
    "clear": 1.0,
    "rain": 0.85,
    "heavy_rain": 0.65,
    "fog": 0.5,
    "monsoon_flagged_section": 0.6,
}


def _to_local_xy(lat, lng, ref_lat, ref_lng):
    """Equirectangular projection to local metres, good enough for short 3-point spans."""
    x = math.radians(lng - ref_lng) * EARTH_RADIUS_M * math.cos(math.radians(ref_lat))
    y = math.radians(lat - ref_lat) * EARTH_RADIUS_M
    return x, y


def haversine_m(lat1, lng1, lat2, lng2):
    """Great-circle distance in metres between two lat/lng points."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


def circumradius(p1, p2, p3):
    """
    Radius of the circle passing through 3 points (local x/y metres).
    Returns math.inf for (near-)straight track -- i.e. no curvature limit.
    """
    (x1, y1), (x2, y2), (x3, y3) = p1, p2, p3
    d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2))
    if abs(d) < 1e-6:
        return math.inf  # collinear -> straight track

    ux = ((x1**2 + y1**2) * (y2 - y3) + (x2**2 + y2**2) * (y3 - y1) + (x3**2 + y3**2) * (y1 - y2)) / d
    uy = ((x1**2 + y1**2) * (x3 - x2) + (x2**2 + y2**2) * (x1 - x3) + (x3**2 + y3**2) * (x2 - x1)) / d

    r = math.hypot(x1 - ux, y1 - uy)
    return r


def permissible_speed_kmh(radius_m, max_train_speed_kmh, weather="clear"):
    """Curve-capped speed, then further capped by weather and the train's rated max."""
    if radius_m == math.inf:
        curve_cap = max_train_speed_kmh
    else:
        curve_cap = CURVE_SPEED_CONSTANT * math.sqrt(radius_m)

    weather_factor = WEATHER_SPEED_FACTOR.get(weather, 1.0)
    return min(curve_cap, max_train_speed_kmh) * weather_factor


def build_segment_profile(geojson_coords, max_train_speed_kmh, weather="clear"):
    """
    geojson_coords: list of [lng, lat] pairs (GeoJSON order!), from
                    RailRadarClient.get_route_geometry(...) or the
                    `geometry` field on the /live endpoint.
    Returns a list of segment dicts: distance_m, radius_m, capped_speed_kmh, eta_seconds
    """
    segments = []
    n = len(geojson_coords)

    if n < 3:
        raise ValueError("Need at least 3 coordinate points to estimate curvature")

    ref_lng, ref_lat = geojson_coords[0]

    for i in range(1, n - 1):
        lng0, lat0 = geojson_coords[i - 1]
        lng1, lat1 = geojson_coords[i]
        lng2, lat2 = geojson_coords[i + 1]

        p1 = _to_local_xy(lat0, lng0, ref_lat, ref_lng)
        p2 = _to_local_xy(lat1, lng1, ref_lat, ref_lng)
        p3 = _to_local_xy(lat2, lng2, ref_lat, ref_lng)

        radius = circumradius(p1, p2, p3)
        seg_distance_m = haversine_m(lat0, lng0, lat1, lng1)

        capped_speed = permissible_speed_kmh(radius, max_train_speed_kmh, weather)
        eta_seconds = (seg_distance_m / 1000) / capped_speed * 3600 if capped_speed > 0 else float("inf")

        segments.append(
            {
                "from": (lat0, lng0),
                "to": (lat1, lng1),
                "distance_m": round(seg_distance_m, 1),
                "radius_m": None if radius == math.inf else round(radius, 1),
                "capped_speed_kmh": round(capped_speed, 1),
                "eta_seconds": round(eta_seconds, 1),
            }
        )

    return segments


def total_segment_eta(segments):
    """Sum of per-segment ETA -- this is your headline USP number."""
    return sum(s["eta_seconds"] for s in segments)


def naive_eta(total_distance_m, avg_speed_kmh):
    """What existing systems do: one average speed for the whole journey."""
    return (total_distance_m / 1000) / avg_speed_kmh * 3600


def densify_coords(coords, max_step_m=100.0, use_spline=True):
    """
    Densify track polyline to a maximum vertex spacing (e.g. 100m).
    Resolves previously curvature-blind long chords.
    """
    import track_geometry
    return track_geometry.densify_track(coords, max_step_m=max_step_m, use_spline=use_spline)


def _demo_hairpin_coords(radius_m=300, ref_lat=17.95, ref_lng=73.30, arc_deg=90, n=6):
    """Generates points on an exact circle -- lets us verify the capping math against
    a *known* radius, rather than eyeballing arbitrary lat/lng points."""
    coords = []
    for i in range(n):
        theta = math.radians(arc_deg * i / (n - 1))
        x = radius_m * math.sin(theta)
        y = radius_m * (1 - math.cos(theta))
        lat = ref_lat + y / EARTH_RADIUS_M * (180 / math.pi)
        lng = ref_lng + x / (EARTH_RADIUS_M * math.cos(math.radians(ref_lat))) * (180 / math.pi)
        coords.append([lng, lat])
    return coords


if __name__ == "__main__":
    # Demo 1: straight-ish stretch -- speed should NOT be capped below max
    straight_coords = [[73.30 + 0.01 * i, 17.95] for i in range(5)]
    straight_segs = build_segment_profile(straight_coords, max_train_speed_kmh=130, weather="clear")
    print("=== Straight stretch ===")
    for s in straight_segs:
        print(s)

    # Demo 2: a tight 300m-radius hairpin (typical of a real ghat-section curve)
    # Expected cap: 4.58 * sqrt(300) ≈ 79.3 km/h -- well below the train's 130 km/h max
    hairpin_coords = _demo_hairpin_coords(radius_m=300)
    hairpin_segs = build_segment_profile(hairpin_coords, max_train_speed_kmh=130, weather="clear")
    print("\n=== 300m-radius hairpin (e.g. ghat section) ===")
    for s in hairpin_segs:
        print(s)

    total_dist = sum(s["distance_m"] for s in hairpin_segs)
    seg_eta = total_segment_eta(hairpin_segs)
    naive = naive_eta(total_dist, 130)
    print(f"\nSegment-wise ETA: {seg_eta:.1f}s  |  Naive (distance/130km/h): {naive:.1f}s")
    print(f"Naive ETA underestimates travel time by {seg_eta - naive:.1f}s on this stretch alone")

    # Demo 3: same hairpin, but foggy conditions
    fog_segs = build_segment_profile(hairpin_coords, max_train_speed_kmh=130, weather="fog")
    fog_eta = total_segment_eta(fog_segs)
    print(f"Same hairpin in fog: {fog_eta:.1f}s (vs {seg_eta:.1f}s in clear weather)")
