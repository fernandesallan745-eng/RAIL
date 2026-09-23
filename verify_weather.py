#!/usr/bin/env python3
"""
verify_weather.py — Automated verification suite for Live Weather Integration.

Asserts:
1. Indian Railways G&SR and Monsoon Adhesion physics calibrations.
2. Fog visibility speed capping (Railway Board FSD guidelines <= 60 km/h).
3. 15-minute geohash caching and zero-failure offline fallback.
4. Per-block live geofenced ETA integration in eta_model.
"""

import sys
import curvature
import weather_service
import eta_model

passed = 0
failed = 0


def check(name, condition, msg=""):
    global passed, failed
    if condition:
        print(f"  ok  {name}")
        passed += 1
    else:
        print(f"  FAIL {name}: {msg}")
        failed += 1


print("=" * 70)
print("RUNNING LIVE WEATHER INTEGRATION VERIFICATION")
print("=" * 70)

# ----------------------------------------------------------------------
# 1. Physics & Calibration Invariants
# ----------------------------------------------------------------------
print("\n=== Test 1: Indian Railways G&SR Weather Physics Calibrations ===")

# Clear sky
c_clear = curvature.weather_factor_from_conditions(wmo_code=0, precip_mm_h=0.0, visibility_m=10000.0)
check("clear sky factor is exactly 1.0", c_clear["factor"] == 1.0 and c_clear["condition"] == "clear")

# Moderate rain adhesion reduction
c_rain = curvature.weather_factor_from_conditions(wmo_code=63, precip_mm_h=6.0, visibility_m=8000.0)
check("moderate rain (6mm/h) reduces speed factor appropriately", 0.75 <= c_rain["factor"] <= 0.85, f"got {c_rain['factor']}")

# Heavy tropical rain downpour
c_heavy = curvature.weather_factor_from_conditions(wmo_code=65, precip_mm_h=20.0, visibility_m=4000.0)
check("heavy tropical rain caps factor to 0.65", c_heavy["factor"] == 0.65, f"got {c_heavy['factor']}")

# Dense fog: visibility 300m should cap 130 km/h train to 60 km/h
c_fog = curvature.weather_factor_from_conditions(wmo_code=45, precip_mm_h=0.0, visibility_m=300.0, max_train_speed_kmh=130.0)
check("dense fog caps permissible speed to 60 km/h (factor <= 0.47)", c_fog["capped_speed_kmh"] <= 60.0 and c_fog["condition"] == "fog")

# Severe thunderstorm
c_storm = curvature.weather_factor_from_conditions(wmo_code=95, precip_mm_h=12.0, visibility_m=3000.0)
check("thunderstorm applies 0.60 safety factor", c_storm["factor"] <= 0.60 and c_storm["condition"] == "thunderstorm")

# ----------------------------------------------------------------------
# 2. Caching & Offline Fallback Invariants
# ----------------------------------------------------------------------
print("\n=== Test 2: Geohash Caching & Offline Resilience ===")
weather_service.clear_cache()

# Fetch point weather
p1 = weather_service.get_point_weather(18.94, 72.83)
check("live point query returns valid weather telemetry", p1["temp_c"] is not None and "factor" in p1)

# Second query should hit cache immediately
cached = weather_service.get_cached_weather(18.94, 72.83)
check("weather telemetry successfully cached in memory", cached is not None and cached == p1)

# Offline fallback
fb = weather_service.fallback_weather("simulated-offline")
check("fallback weather provides safe 1.0 baseline", fb["factor"] == 1.0 and "fallback" in fb["basis"])

# Batch coordinates query
batch = weather_service.get_batch_weather([(18.94, 72.83), (18.52, 73.13), (17.64, 73.38), (15.26, 73.97)])
check("batch weather query resolves all points", len(batch) >= 4)

# ----------------------------------------------------------------------
# 3. Model Geofenced ETA Invariants
# ----------------------------------------------------------------------
print("\n=== Test 3: Model Dynamic Geofenced ETA ===")

res_live = eta_model.compute_eta("22229", weather="live")
check("live weather ETA computation completed", res_live["totals"]["predicted_eta_min"] > 0)
check("live weather mode identified as live-geofenced", res_live["weather_mode"] == "live-geofenced")

summary = res_live.get("weather_summary", {})
check("weather summary present with per-block diagnostics", "adverse_blocks" in summary and "min_factor" in summary)

has_telemetry = all("weather_telemetry" in s for s in res_live["segments"])
check("all route segments carry atmospheric telemetry", has_telemetry)

# Backward compatibility: verify static weather simulations still produce exact baseline
res_static = eta_model.compute_eta("22229", weather="rain")
check("static weather mode preserved for simulations", res_static["weather_factor"] == 0.85)

print("\n" + "=" * 70)
if failed == 0:
    print("ALL LIVE WEATHER INTEGRATION VERIFICATION CHECKS PASSED")
else:
    print(f"FAILED: {failed} check(s)")
print("=" * 70)

sys.exit(0 if failed == 0 else 1)
