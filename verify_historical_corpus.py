#!/usr/bin/env python3
"""
verify_historical_corpus.py — Automated verification for Phase 4:
Expanding the Historical Delay Training Corpus (N) & Segment Delay Distributions.

Tests:
1. Multi-train historical corpus coverage:
   - Validates that multiple corridor trains (12051, 12052, 22229, etc.) have valid dated runs.
   - Confirms train 12051 now has empirical delay telemetry (no-dated-runs-cached eliminated).
2. Segment delay distribution mathematics:
   - Tests rank-linear quantile interpolation (p50, p80, p95).
   - Validates per-halt distribution metrics (mean, median, p80, p95, sigma).
3. End-to-end quantile monotonicity and confidence bands:
   - Validates p50 <= p80 <= p95 monotonicity on total predicted ETA.
   - Validates calibrated uncertainty buffers (+/- min).
4. Backward compatibility & zero-drift:
   - Default quantile="mean" yields exact numerical agreement with the baseline.
5. FastAPI integration:
   - Validates /eta/{train}?quantile=p80 and /historical/{train} endpoints.
"""

import sys
import os
import math
import eta_model
import api

def test_multi_train_corpus():
    print("--- 1. Multi-Train Corpus Coverage ---")
    import glob
    cached_trains = sorted({
        os.path.basename(p).split("_live")[0]
        for p in glob.glob(os.path.join(eta_model.CACHE, "*_live*.json"))
        if os.path.basename(p).split("_live")[0].isdigit()
    })
    print(f"Total cached trains with live snapshots: {len(cached_trains)}")
    assert len(cached_trains) >= 15, f"Expected >= 15 cached trains, found {len(cached_trains)}"

    # Check specific key Konkan corridor trains
    for tr in ["22229", "12051", "12052"]:
        runs = eta_model.list_dated_runs(tr)
        real_runs = [
            d for d, j in runs.items()
            if len([s for s in j.get("route", []) if s.get("isHalt")]) >= 2
            and [s for s in j.get("route", []) if s.get("isHalt")][-1].get("delayArrival") is not None
        ]
        print(f"Train {tr}: {len(runs)} dated runs cached, {len(real_runs)} with real delay telemetry.")
        assert len(real_runs) >= 1, f"Train {tr} expected >= 1 real delay run, got {len(real_runs)}"

    print("✔ Multi-train historical corpus verified.")


def test_distribution_math():
    print("\n--- 2. Quantile Distribution Mathematics ---")
    # Single sample
    assert eta_model.compute_quantile([10.0], 0.5) == 10.0
    assert eta_model.compute_quantile([10.0], 0.8) == 10.0
    assert eta_model.compute_quantile([10.0], 0.95) == 10.0

    # Multi-sample (odd)
    odd = [10.0, 20.0, 30.0, 40.0, 50.0]
    assert eta_model.compute_quantile(odd, 0.5) == 30.0
    p80 = eta_model.compute_quantile(odd, 0.8)
    assert p80 == 42.0, f"Expected 42.0, got {p80}"
    p95 = eta_model.compute_quantile(odd, 0.95)
    assert round(p95, 2) == 48.0, f"Expected 48.0, got {p95}"

    # Segment delay distributions on train 22229
    dists = eta_model.segment_delay_distributions("22229")
    assert len(dists) >= 8, f"Expected >= 8 halt segments, got {len(dists)}"
    for key, stat in dists.items():
        assert stat["n"] >= 1
        assert stat["min"] <= stat["median"] <= stat["max"]
        assert stat["min"] <= stat["p80"] <= stat["max"]
        assert stat["min"] <= stat["p95"] <= stat["max"]
        assert stat["median"] <= stat["p80"] <= stat["p95"]

    print("✔ Quantile interpolation & segment distribution mathematics verified.")


def test_quantile_monotonicity_and_bands():
    print("\n--- 3. Quantile Monotonicity & Confidence Bands (22229) ---")
    eta_p50 = eta_model.compute_eta("22229", quantile="p50")
    eta_mean = eta_model.compute_eta("22229", quantile="mean")
    eta_p80 = eta_model.compute_eta("22229", quantile="p80")
    eta_p95 = eta_model.compute_eta("22229", quantile="p95")

    tot_p50 = eta_p50["totals"]["predicted_eta_min"]
    tot_mean = eta_mean["totals"]["predicted_eta_min"]
    tot_p80 = eta_p80["totals"]["predicted_eta_min"]
    tot_p95 = eta_p95["totals"]["predicted_eta_min"]

    print(f"p50 (median) ETA:       {tot_p50} min")
    print(f"mean (expected) ETA:    {tot_mean} min")
    print(f"p80 (conservative) ETA: {tot_p80} min")
    print(f"p95 (stress) ETA:       {tot_p95} min")

    assert tot_p50 <= tot_mean <= tot_p80 <= tot_p95, (
        f"Monotonicity violated: p50={tot_p50}, mean={tot_mean}, p80={tot_p80}, p95={tot_p95}"
    )

    cb = eta_mean["totals"]["confidence_bands"]
    assert cb["available"] is True
    assert cb["sample_count"] >= 5
    assert cb["uncertainty_min_80"] > 0
    assert cb["uncertainty_min_95"] >= cb["uncertainty_min_80"]
    print(f"Confidence Bands: 80% ±{cb['uncertainty_min_80']}m, 95% ±{cb['uncertainty_min_95']}m")

    print("✔ Quantile monotonicity & confidence bands verified.")


def test_baseline_zero_drift():
    print("\n--- 4. Baseline Zero-Drift Regression ---")
    # Baseline ETA under clear weather in compute_eta
    eta_default = eta_model.compute_eta("22229", weather="clear", max_speed=130.0)
    assert eta_default["totals"]["predicted_eta_min"] == 618.8, (
        f"Expected 618.8, got {eta_default['totals']['predicted_eta_min']}"
    )
    assert eta_default["totals"]["quantile"] == "mean"
    print("✔ Exact zero-drift baseline verified (618.8 min matching report_eta.py).")


def test_fastapi_endpoints():
    print("\n--- 5. FastAPI Endpoints (/eta, /historical) ---")
    import json
    from fastapi import HTTPException

    # 1. GET /eta/12051 with quantile=p80
    res_eta = api.get_eta("12051", quantile="p80")
    data = json.loads(res_eta.body.decode())
    assert data["totals"]["quantile"] == "p80"
    assert data["totals"]["confidence_bands"]["available"] is True
    print(f"Train 12051 (p80 ETA): {data['totals']['predicted_eta_min']} min, "
          f"band: ±{data['totals']['confidence_bands']['uncertainty_min_80']}m")

    # 2. GET /historical/22229
    res_hist = api.get_historical_delay_corpus("22229")
    hist_data = json.loads(res_hist.body.decode())
    assert hist_data["sample_count"] >= 5
    assert len(hist_data["segment_distributions"]) >= 8
    print(f"Train 22229 historical audit: N={hist_data['sample_count']}, "
          f"{len(hist_data['segment_distributions'])} segment distributions.")

    # 3. GET /historical/12051
    res_hist12051 = api.get_historical_delay_corpus("12051")
    hist12051 = json.loads(res_hist12051.body.decode())
    assert hist12051["sample_count"] >= 1
    print(f"Train 12051 historical audit: N={hist12051['sample_count']}, "
          f"dates: {hist12051['dates_with_real_delay_signal']}")

    # 4. Invalid quantile should return 422
    try:
        api.get_eta("22229", quantile="invalid_q")
        assert False, "Expected HTTPException 422"
    except HTTPException as e:
        assert e.status_code == 422

    print("✔ FastAPI /eta and /historical endpoints verified.")


if __name__ == "__main__":
    test_multi_train_corpus()
    test_distribution_math()
    test_quantile_monotonicity_and_bands()
    test_baseline_zero_drift()
    test_fastapi_endpoints()
    print("\n==========================================")
    print("ALL PHASE 4 VERIFICATION TESTS PASSED! 🎉")
    print("==========================================")
