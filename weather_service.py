"""
weather_service.py — Live Meteorological Telemetry & Speed Capping Client.

Queries the free, keyless Open-Meteo API (https://api.open-meteo.com) for real-time
atmospheric conditions (precipitation rate, WMO weather codes, visibility, temperature,
and wind speed) along train routes.

Calculates speed restriction factors calibrated against Indian Railways G&SR,
monsoon cautionary orders, and Railway Board fog safety protocols.

Features:
- In-memory 15-minute TTL cache per ~1.1km geohash (lat/lng rounded to 2 decimals)
- Fast batch-point queries for route polylines
- Robust graceful fallback to clear weather (1.0 factor) if network is unreachable
"""

import time
import math
import json
import logging
import urllib.request
import urllib.parse
import curvature

logger = logging.getLogger(__name__)

OPEN_METEO_BASE_URL = "https://api.open-meteo.com/v1/forecast"
CACHE_TTL_SECONDS = 900  # 15 minutes

# In-memory cache: (round(lat, 2), round(lng, 2)) -> (timestamp, weather_dict)
_WEATHER_CACHE = {}


def _cache_key(lat, lng):
    return (round(float(lat), 2), round(float(lng), 2))


def get_cached_weather(lat, lng):
    key = _cache_key(lat, lng)
    if key in _WEATHER_CACHE:
        ts, data = _WEATHER_CACHE[key]
        if time.time() - ts < CACHE_TTL_SECONDS:
            return data
    return None


def store_cached_weather(lat, lng, data):
    key = _cache_key(lat, lng)
    _WEATHER_CACHE[key] = (time.time(), data)


def fallback_weather(reason="clear-default"):
    return {
        "factor": 1.0,
        "condition": "clear",
        "temp_c": 28.0,
        "precip_mm_h": 0.0,
        "visibility_m": 10000.0,
        "wmo_code": 0,
        "wmo_description": "Clear sky",
        "wind_speed_kmh": 5.0,
        "basis": f"fallback-{reason}",
    }


def get_point_weather(lat, lng, max_train_speed_kmh=130.0, timeout=2.5):
    """
    Fetch real-time atmospheric conditions for a single (lat, lng) point.
    """
    if lat is None or lng is None:
        return fallback_weather("missing-coords")

    cached = get_cached_weather(lat, lng)
    if cached is not None:
        return cached

    try:
        query_str = urllib.parse.urlencode({
            "latitude": round(float(lat), 4),
            "longitude": round(float(lng), 4),
            "current": "temperature_2m,relative_humidity_2m,precipitation,rain,weather_code,wind_speed_10m,visibility",
            "timezone": "auto",
        })
        url = f"{OPEN_METEO_BASE_URL}?{query_str}"
        req = urllib.request.Request(url, headers={"User-Agent": "GATI-RailSync/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as response:
            if response.status == 200:
                raw = json.loads(response.read().decode("utf-8"))
                data = raw.get("current", {})
                precip = float(data.get("precipitation") or data.get("rain") or 0.0)
                vis = float(data.get("visibility") or 10000.0)
                wmo = data.get("weather_code")
                temp = float(data.get("temperature_2m") or 25.0)
                wind = float(data.get("wind_speed_10m") or 0.0)

                calibrated = curvature.weather_factor_from_conditions(
                    wmo_code=wmo,
                    precip_mm_h=precip,
                    visibility_m=vis,
                    max_train_speed_kmh=max_train_speed_kmh,
                )

                result = {
                    "factor": calibrated["factor"],
                    "condition": calibrated["condition"],
                    "temp_c": round(temp, 1),
                    "precip_mm_h": round(precip, 2),
                    "visibility_m": round(vis, 0),
                    "wmo_code": calibrated["wmo_code"],
                    "wmo_description": calibrated["wmo_description"],
                    "wind_speed_kmh": round(wind, 1),
                    "basis": "live-open-meteo",
                }
                store_cached_weather(lat, lng, result)
                return result
    except Exception as e:
        logger.warning(f"[WeatherService] Failed to query Open-Meteo for ({lat}, {lng}): {e}")

    fb = fallback_weather("unreachable")
    store_cached_weather(lat, lng, fb)
    return fb


def get_batch_weather(points, max_train_speed_kmh=130.0, timeout=3.5):
    """
    Fetch weather for a list of (lat, lng, id/name) points in a single batch query.
    """
    if not points:
        return {}

    results = {}
    uncached = []

    for item in points:
        lat, lng = item[0], item[1]
        c = get_cached_weather(lat, lng)
        if c is not None:
            results[(lat, lng)] = c
        else:
            uncached.append((lat, lng))

    if not uncached:
        return results

    try:
        # Group coordinates into batch strings
        lats = ",".join(str(round(float(p[0]), 4)) for p in uncached)
        lngs = ",".join(str(round(float(p[1]), 4)) for p in uncached)

        query_str = urllib.parse.urlencode({
            "latitude": lats,
            "longitude": lngs,
            "current": "temperature_2m,relative_humidity_2m,precipitation,rain,weather_code,wind_speed_10m,visibility",
            "timezone": "auto",
        })
        url = f"{OPEN_METEO_BASE_URL}?{query_str}"
        req = urllib.request.Request(url, headers={"User-Agent": "GATI-RailSync/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as response:
            if response.status == 200:
                payload = json.loads(response.read().decode("utf-8"))
            if isinstance(payload, list):
                items = payload
            else:
                items = [payload]

            for i, pdata in enumerate(items):
                if i < len(uncached):
                    lat, lng = uncached[i]
                    cur = pdata.get("current", {})
                    precip = float(cur.get("precipitation") or cur.get("rain") or 0.0)
                    vis = float(cur.get("visibility") or 10000.0)
                    wmo = cur.get("weather_code")
                    temp = float(cur.get("temperature_2m") or 25.0)
                    wind = float(cur.get("wind_speed_10m") or 0.0)

                    cal = curvature.weather_factor_from_conditions(
                        wmo_code=wmo,
                        precip_mm_h=precip,
                        visibility_m=vis,
                        max_train_speed_kmh=max_train_speed_kmh,
                    )

                    res = {
                        "factor": cal["factor"],
                        "condition": cal["condition"],
                        "temp_c": round(temp, 1),
                        "precip_mm_h": round(precip, 2),
                        "visibility_m": round(vis, 0),
                        "wmo_code": cal["wmo_code"],
                        "wmo_description": cal["wmo_description"],
                        "wind_speed_kmh": round(wind, 1),
                        "basis": "live-open-meteo",
                    }
                    store_cached_weather(lat, lng, res)
                    results[(lat, lng)] = res
    except Exception as e:
        logger.warning(f"[WeatherService] Batch query failed: {e}")

    for lat, lng in uncached:
        if (lat, lng) not in results:
            fb = fallback_weather("batch-unreachable")
            store_cached_weather(lat, lng, fb)
            results[(lat, lng)] = fb

    return results


def clear_cache():
    _WEATHER_CACHE.clear()
