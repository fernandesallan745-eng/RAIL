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
# These baseline values serve as fallback/simulation multipliers and
# are calibrated against Indian Railways G&SR and Monsoon Working Rules.
WEATHER_SPEED_FACTOR = {
    "clear": 1.0,
    "drizzle": 0.92,
    "rain": 0.85,
    "heavy_rain": 0.65,
    "fog": 0.50,
    "thunderstorm": 0.60,
    "monsoon_flagged_section": 0.60,
}

# Standard WMO Weather Interpretation Codes (WMO Code 4677)
WMO_WEATHER_TABLE = {
    0: {"name": "Clear sky", "condition": "clear", "base_factor": 1.0},
    1: {"name": "Mainly clear", "condition": "clear", "base_factor": 1.0},
    2: {"name": "Partly cloudy", "condition": "clear", "base_factor": 1.0},
    3: {"name": "Overcast", "condition": "clear", "base_factor": 1.0},
    45: {"name": "Fog", "condition": "fog", "base_factor": 0.50},
    48: {"name": "Depositing rime fog", "condition": "fog", "base_factor": 0.50},
    51: {"name": "Light drizzle", "condition": "drizzle", "base_factor": 0.95},
    53: {"name": "Moderate drizzle", "condition": "drizzle", "base_factor": 0.90},
    55: {"name": "Dense drizzle", "condition": "drizzle", "base_factor": 0.85},
    61: {"name": "Slight rain", "condition": "rain", "base_factor": 0.90},
    63: {"name": "Moderate rain", "condition": "rain", "base_factor": 0.82},
    65: {"name": "Heavy rain", "condition": "heavy_rain", "base_factor": 0.68},
    71: {"name": "Slight snow", "condition": "snow", "base_factor": 0.80},
    73: {"name": "Moderate snow", "condition": "snow", "base_factor": 0.70},
    75: {"name": "Heavy snow", "condition": "snow", "base_factor": 0.55},
    80: {"name": "Slight rain showers", "condition": "rain", "base_factor": 0.88},
    81: {"name": "Moderate rain showers", "condition": "rain", "base_factor": 0.80},
    82: {"name": "Violent rain showers", "condition": "heavy_rain", "base_factor": 0.65},
    95: {"name": "Thunderstorm", "condition": "thunderstorm", "base_factor": 0.60},
    96: {"name": "Thunderstorm with slight hail", "condition": "thunderstorm", "base_factor": 0.55},
    99: {"name": "Thunderstorm with heavy hail", "condition": "thunderstorm", "base_factor": 0.50},
}


def weather_factor_from_conditions(
    wmo_code=None,
    precip_mm_h=0.0,
    visibility_m=10000.0,
    max_train_speed_kmh=130.0,
):
    """
    Compute a physically calibrated speed factor based on live atmospheric telemetry
    and Indian Railways General & Subsidiary Rules (G&SR).

    Calibrations:
    1. Fog / Poor Visibility (Railway Board FSD guidelines):
       Under fog conditions (visibility < 1000m), trains with Fog Pass Devices (FSD)
       are restricted to max 60 km/h (or 75 km/h for semi-high speed coaching).
    2. Adhesion Loss under Monsoon Rain:
       Wheel-rail friction coefficient drops from ~0.25 to ~0.12 under active precipitation,
       increasing braking distance and requiring proactive deceleration on grades.
       Formula: f_rain = max(0.65, 1.0 - 0.035 * P_mm_h)
    3. Severe Thunderstorm / Squalls:
       WMO 95-99 imposes caution order (~60 km/h baseline).
    """
    precip = max(0.0, float(precip_mm_h or 0.0))
    vis = max(10.0, float(visibility_m or 10000.0))
    code = int(wmo_code) if wmo_code is not None else 0

    entry = WMO_WEATHER_TABLE.get(code, {"name": "Clear", "condition": "clear", "base_factor": 1.0})
    condition = entry["condition"]
    wmo_name = entry["name"]

    # 1. Fog speed cap factor
    if vis < 1000.0 or code in (45, 48):
        condition = "fog"
        # IR rules: max 60 km/h under dense fog
        fog_speed_cap = 60.0
        if vis > 500.0:
            # Linear transition between 500m and 1000m
            fog_speed_cap = 60.0 + (vis - 500.0) / 500.0 * 20.0
        fog_factor = min(1.0, fog_speed_cap / max(60.0, max_train_speed_kmh))
    else:
        fog_factor = 1.0
        fog_speed_cap = max_train_speed_kmh

    # 2. Rain / Precipitation adhesion factor
    if precip > 0.1:
        if precip >= 15.0:
            condition = "heavy_rain"
            rain_factor = 0.65
        elif precip >= 5.0:
            condition = "rain"
            rain_factor = max(0.70, 1.0 - 0.035 * precip)
        else:
            condition = "drizzle"
            rain_factor = max(0.85, 1.0 - 0.03 * precip)
    else:
        rain_factor = entry["base_factor"]

    # 3. Severe convective weather (Thunderstorms)
    if code in (95, 96, 99):
        condition = "thunderstorm"
        storm_factor = 0.60
    else:
        storm_factor = 1.0

    combined_factor = min(fog_factor, rain_factor, storm_factor)
    combined_factor = round(max(0.40, min(1.0, combined_factor)), 3)
    speed_cap = min(max_train_speed_kmh * combined_factor, fog_speed_cap)

    return {
        "factor": combined_factor,
        "condition": condition,
        "wmo_code": code,
        "wmo_description": wmo_name,
        "precip_mm_h": round(precip, 2),
        "visibility_m": round(vis, 0),
        "capped_speed_kmh": round(speed_cap, 1),
        "basis": "live-open-meteo-calibrated",
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

    if isinstance(weather, (int, float)):
        weather_factor = float(weather)
    elif isinstance(weather, dict):
        weather_factor = float(weather.get("factor", 1.0))
    else:
        weather_factor = WEATHER_SPEED_FACTOR.get(str(weather), 1.0)

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
