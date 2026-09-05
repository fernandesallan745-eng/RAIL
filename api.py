"""
api.py — FastAPI wrapper around the combined ETA model.  Demo-able live.

Run:
    uvicorn api:app --reload --port 8000

Endpoints:
    GET /                         → service info
    GET /health                   → cache status (which trains/dates are available)
    GET /dashboard                → operator dashboard (static HTML)
    GET /admin                    → layer-by-layer model audit console (static HTML)
    GET /eta/{train_number}?date=YYYY-MM-DD[&weather=clear][&mode=block|vertex]
                                  → per-segment breakdown + total ETA
    GET /eta/{train_number}/curvature
                                  → curvature-only view (sharpest curves, ghat isolation)

Cache-first: the model reads .cache/*.json and makes no upstream API calls.
"""
from datetime import datetime, timedelta
import asyncio
import glob
import os
import re

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, FileResponse

import curvature
import eta_model

HERE = os.path.dirname(os.path.abspath(__file__))

app = FastAPI(
    title="Curvature & Delay-Aware ETA — Indian Railways",
    description=(
        "Dynamic ETA prediction combining schedule-derived baseline speed, RDSO "
        "curvature speed caps (V=4.58·√R), weather multipliers, data-derived "
        "historical delay, and halt dwell time."
    ),
    version="1.0.0",
)


@app.get("/")
def root():
    return {
        "service": "curvature-delay-aware-eta",
        "reference_train": "22229 (CSMT–Madgaon Vande Bharat)",
        "model_layers": [
            "1. baseline: schedule-derived speedToNextStationKmph per halt-to-halt block",
            "2. curvature: RDSO V = 4.58*sqrt(R) from GeoJSON circumcircle radii",
            "3. weather: multiplier on the physics-capped speed",
            "4. historical delay: mean INCREMENTAL delay per block, differenced from the "
            "cumulative delayArrival across cached runs that carry a real signal",
            "5. dwell: scheduledDeparture - scheduledArrival at the arriving halt",
            "6. conflict holds: minutes standing in a loop while a higher-precedence "
            "train crosses or overtakes on single line (Roha-Madgaon). Computed from "
            "cached static timetables — no upstream request for any other train.",
        ],
        "formula": (
            "segment_eta = distance / min(baseline, curve_cap, weather_cap) "
            "+ hist_avg_delay + dwell + conflict_hold"
        ),
        "curvature_modes": {
            "vertex": "DEFAULT. Each sub-segment (median ~195 m) capped by its own radius, then "
                      "integrated. Physically correct. On Konkan (22229) curvature's "
                      "aggregate effect is +0.0013 min of 635 — it binds on ONE 80 m "
                      "sub-segment, because the timetable's own baseline speeds (28-77 "
                      "km/h) already sit below the RDSO curve caps almost everywhere.",
            "block": "Conservative upper bound: the sharpest curve in a halt-to-halt "
                     "block caps the WHOLE block. Overstates PNVL->KHED by ~3 min "
                     "because R=268m covers only ~79m of track. Use only when the data "
                     "source exposes one radius per block, and label it as an upper bound.",
        },
        # published so the dashboards can show the actual multipliers next to the
        # "untuned placeholder" warning instead of hardcoding a copy that can drift
        # out of step with curvature.py
        "weather_factors": curvature.WEATHER_SPEED_FACTOR,
        "weather_factors_provenance": (
            "PLACEHOLDER estimates, not derived from TSR/RDSO data. Weather capping is "
            "implemented; a live weather feed (OpenWeatherMap/IMD) is the next integration."
        ),
        "endpoints": ["/health", "/eta/{train_number}", "/eta/{train_number}/curvature",
                      "/conflicts/{train_number}",
                      "/dashboard", "/admin", "/geometry/{train_number}"],
    }


@app.get("/dashboard")
def dashboard():
    """Serve the operator dashboard (Phase 8). Static file, no templating."""
    path = os.path.join(HERE, "dashboard.html")
    if not os.path.exists(path):
        raise HTTPException(404, detail="dashboard.html not found next to api.py")
    # no-store, not just an ETag: without an explicit Cache-Control a browser is free to
    # apply heuristic freshness (~10% of the age since Last-Modified) and serve the page
    # from cache WITHOUT revalidating, so an edited dashboard looks like it never changed.
    return FileResponse(path, media_type="text/html",
                        headers={"Cache-Control": "no-store, must-revalidate"})


@app.get("/admin")
def admin():
    """Serve the layer-by-layer model audit console (judge-facing).

    Same static-file contract as /dashboard: no templating, no build step, and every
    number on the page is fetched from the endpoints below rather than baked in.
    """
    path = os.path.join(HERE, "admin.html")
    if not os.path.exists(path):
        raise HTTPException(404, detail="admin.html not found next to api.py")
    return FileResponse(path, media_type="text/html",
                        headers={"Cache-Control": "no-store, must-revalidate"})


def _cache_fingerprint():
    """mtime+size of every cache file, so a change to any of them is detectable.

    This is what 'live' means in this build: the model is cache-only, so the thing that
    can actually change under us is the cache (e.g. fetch_dates.py adding a run date).
    It is NOT a live train feed — do not present it as one.
    """
    import glob
    out = []
    for p in sorted(glob.glob(os.path.join(eta_model.CACHE, "*.json"))):
        try:
            st = os.stat(p)
            out.append((os.path.basename(p), int(st.st_mtime), st.st_size))
        except OSError:
            continue
    return out


@app.websocket("/ws/eta/{train_number}")
async def ws_eta(ws: WebSocket, train_number: str, weather: str = "clear", mode: str = "vertex"):
    """
    Push-based updates for the dashboard (the pitched stack is WebSocket, not polling).

    Sends one payload immediately on connect, then pushes a fresh one whenever the cache
    fingerprint changes.  Heartbeats in between so the client can show an honest
    connection state instead of silently going stale.
    """
    await ws.accept()
    last = None
    try:
        while True:
            fp = _cache_fingerprint()
            if fp != last:
                last = fp
                try:
                    payload = _eta_payload(train_number, None, weather, mode)
                    await ws.send_json({"type": "eta", "data": payload})
                except FileNotFoundError as e:
                    await ws.send_json({"type": "error", "detail": str(e)})
                    return
            else:
                await ws.send_json({"type": "heartbeat", "cache_files": len(fp)})
            await asyncio.sleep(5)
    except WebSocketDisconnect:
        return
    except Exception:
        # never let a client-side drop take the server process with it
        return


@app.get("/geometry/{train_number}")
def geometry(
    train_number: str,
    max_points: int = Query(700, ge=50, le=5000,
                            description="decimate the polyline to at most this many points"),
):
    """
    Route polyline + halt anchor positions, for drawing.

    Decimated by uniform stride for SVG rendering — the full 1184 vertices are more
    than a chart needs.  Curvature is NOT recomputed from the decimated set (that
    would coarsen the radii); it always comes from the full polyline via /eta.
    """
    try:
        coords = eta_model.load_route_coords(train_number)
        _, stations, _ = eta_model.load_schedule(train_number)
    except FileNotFoundError as e:
        raise HTTPException(404, detail=f"no cache for train {train_number}. ({e})")

    halts = [s for s in stations if s.get("isHalt")]
    halt_idx = eta_model.snap_halts_to_vertices(coords, halts)

    stride = max(1, len(coords) // max_points)
    kept = list(range(0, len(coords), stride))
    if kept[-1] != len(coords) - 1:
        kept.append(len(coords) - 1)
    # keep every halt vertex even if the stride would skip it, so markers sit on the line
    kept = sorted(set(kept) | set(halt_idx))
    remap = {orig: i for i, orig in enumerate(kept)}

    return {
        "train": train_number,
        "points": [[round(coords[i][0], 5), round(coords[i][1], 5)] for i in kept],
        "full_vertex_count": len(coords),
        "decimated_to": len(kept),
        "stride": stride,
        "halts": [
            {
                "code": h["stationCode"], "name": h.get("stationName"),
                "km": h.get("distance"), "point_index": remap[halt_idx[k]],
                "lat": h.get("lat"), "lng": h.get("lng"),
            }
            for k, h in enumerate(halts)
        ],
        "note": "polyline decimated for drawing only; curvature always uses all vertices",
    }


@app.get("/health")
def health(train: str = eta_model.DEFAULT_TRAIN):
    """Which dates are available in the local cache for `train`, and whether they
    carry a real delay signal (trackingMode='real-time') or are zero-echo.

    The real/zero-echo test MUST be the same one the delay layer applies, or this
    endpoint contradicts the model it is meant to audit.  So it reuses
    `eta_model.list_dated_runs()` and repeats the exact condition from
    `historical_delay_increment_by_seq()` — a non-null `delayArrival` at the final
    halt.  An earlier version re-globbed the cache itself and reached for
    `payload["data"]["route"]`; the dated cache files store `route` at the TOP level,
    so every halt list came back empty and all 9 dates were mislabelled zero-echo
    while the delay layer was happily using 5 of them.

    `train` is a QUERY PARAM because this endpoint was previously train-blind: it
    called `list_dated_runs()` with no argument, which defaults to DEFAULT_TRAIN,
    so a caller asking about 12051 was handed 22229's dates.  The Node gateway used
    exactly that list to retry an uncached train on a "known-good" date and got a
    second 404, which it then reported as "ETA model offline" — a healthy model
    misdiagnosed as down.  `cached_trains` is returned alongside so a caller can
    see which trains exist at all instead of inferring it from a date list.
    """
    runs_by_date = eta_model.list_dated_runs(train)
    runs, real, echo, modes = [], [], [], {}
    for d, j in runs_by_date.items():
        runs.append(d)
        modes[d] = j.get("trackingMode")
        halts = [s for s in j.get("route", []) if s.get("isHalt")]
        if len(halts) >= 2 and halts[-1].get("delayArrival") is not None:
            real.append(d)
        else:
            echo.append(d)

    # Every train with any cached live snapshot, dated or not — the set /eta can serve.
    cached_trains = sorted({
        os.path.basename(p).split("_live")[0]
        for p in glob.glob(os.path.join(eta_model.CACHE, "*_live*.json"))
        if os.path.basename(p).split("_live")[0].isdigit()
    })

    # Corridor cache: the static timetables the conflict layer crosses against.
    # Reported separately from `cached_trains` because it is a different artifact
    # with different needs — /conflicts wants a corridor file and no geometry,
    # /eta wants geometry and a live snapshot. A train can be servable by one and
    # not the other, and conflating them is what previously turned a partly-primed
    # cache into a misleading "model offline".
    corridor_trains = sorted(
        os.path.basename(p)[:-5]
        for p in glob.glob(os.path.join(eta_model.CACHE, "corridor", "*.json"))
    )

    return {
        "status": "ok",
        "cache_dir": eta_model.CACHE,
        "train": train,
        "cached_trains": cached_trains,
        "corridor_trains": corridor_trains,
        "conflict_layer_available": train in corridor_trains,
        "corridor_note": (
            "Static timetables for crossing/overtake prediction, built offline by "
            "scripts/build_corridor.py. Schedules do not expire, so these need no "
            "refresh and cost no upstream request."
        ),
        "route_geometry_cached": os.path.exists(
            os.path.join(eta_model.CACHE, f"{train}_route.json")
        ),
        "cached_dated_runs": runs,
        "dates_with_real_delay_signal": real,
        "zero_echo_dates": echo,
        "tracking_mode_by_date": modes,
        "signal_test": "len(halts) >= 2 and halts[-1]['delayArrival'] is not None",
        "note": (
            f"{len(real)} of {len(runs)} cached dates for {train} return real actuals; the "
            "rest are zero-echo (trackingMode='none', actualArrival == scheduledArrival) and "
            "are SKIPPED by the delay layer rather than averaged in as zeros. delayArrival is "
            "cumulative, so it is differenced along the halt chain before per-segment use. "
            "The signal is per-date, not per-tier — always audit, never assume. Dates listed "
            "here apply to `train` ONLY; they are not valid for any other train number."
        ),
    }


def _eta_payload(train_number, date, weather, mode, max_speed=None):
    """
    Build the full ETA payload.  Shared by GET /eta and the WebSocket push so the two
    can never drift apart — a dashboard that renders one shape over REST and a different
    shape over the socket is a bug waiting for the demo.

    Raises FileNotFoundError (callers translate it: 404 for REST, error frame for WS).
    """
    if max_speed is None:
        max_speed = eta_model.MAX_SPEED_KMH
    res = eta_model.compute_eta(train_number, date=date, weather=weather,
                                max_speed=max_speed,
                                conflicts=True, conflict_delay_min=0.0)
    t = res["totals"]

    # 'vertex' mode swaps the physics layer for per-vertex integration
    if mode == "vertex":
        vrun = sum(s["vertex_curve_running_min"] for s in res["segments"])
        for s in res["segments"]:
            s["running_min_applied"] = s["vertex_curve_running_min"]
            s["segment_eta_min"] = round(
                s["vertex_curve_running_min"] + s["hist_delay_min"]
                + s["dwell_min"] + s["conflict_hold_min"], 2
            )
            # `effective_speed_kmh` is the BLOCK-mode speed: the block's sharpest
            # radius applied to its whole length.  In vertex mode only the sub-segments
            # that actually curve are capped, so the block's mean speed is higher.
            # Publish that mean too, or distance/running_min_applied won't reconcile
            # with the speed field and the breakdown looks self-contradictory.
            s["effective_speed_applied_kmh"] = (
                round(s["distance_km"] / (s["vertex_curve_running_min"] / 60.0), 1)
                if s["vertex_curve_running_min"] > 0 else None
            )
        total = vrun + t["historical_delay_min"] + t["dwell_min"] + t["conflict_hold_min"]
        t["running_min"] = round(vrun, 1)
        t["predicted_eta_min"] = round(total, 1)
        t["gap_vs_schedule_min"] = (
            round(total - t["scheduled_duration_min"], 1) if t["scheduled_duration_min"] else None
        )
    else:
        for s in res["segments"]:
            s["running_min_applied"] = s["running_min"]
            s["effective_speed_applied_kmh"] = s["effective_speed_kmh"]

    res["curvature_mode"] = mode

    # predicted arrival clock time, anchored on the origin's scheduled departure
    #
    # load_schedule() deliberately falls back to ANY cached run when the requested
    # date has no cache file — block timings are date-independent, so the DURATION
    # stays valid.  But that file's ISO strings carry its OWN date prefix, so
    # publishing them unshifted stamps the answer with the wrong day (asking for
    # 2026-08-31 returned a 2026-08-08 arrival).  That is the same date-prefix trap
    # as VERIFIED #4 v1.  Shift every clock field by whole days onto the requested
    # date — whole days so any overnight departure→arrival offset is preserved — and
    # declare the substitution in the payload rather than letting it pass silently.
    _, stations, sched_src = eta_model.load_schedule(train_number, date)
    halts = [s for s in stations if s.get("isHalt")]
    dep_iso = halts[0].get("scheduledDeparture") if halts else None

    src_match = re.search(r"(\d{4}-\d{2}-\d{2})", sched_src or "")
    res["schedule_source_date"] = src_match.group(1) if src_match else None
    res["schedule_date_substituted"] = bool(
        date and res["schedule_source_date"] and date != res["schedule_source_date"]
    )

    if dep_iso:
        dep_dt = datetime.fromisoformat(dep_iso)
        shift = timedelta(0)
        if date:
            try:
                shift = datetime.strptime(date, "%Y-%m-%d").date() - dep_dt.date()
            except ValueError:
                shift = timedelta(0)
        dep_dt = dep_dt + shift
        arr_dt = dep_dt + timedelta(minutes=t["predicted_eta_min"])
        res["origin_departure"] = dep_dt.isoformat()
        res["predicted_arrival"] = arr_dt.isoformat()
        sched_arr = halts[-1].get("scheduledArrival")
        if sched_arr:
            sched_arr_dt = datetime.fromisoformat(sched_arr) + shift
            res["scheduled_arrival"] = sched_arr_dt.isoformat()
            res["arrival_delta_min"] = round(
                (arr_dt - sched_arr_dt).total_seconds() / 60, 1
            )
        else:
            res["scheduled_arrival"] = sched_arr

    res["comparison"] = {
        "naive_flat_speed_min": t["naive_flat_speed_min"],
        "combined_model_min": t["predicted_eta_min"],
        "scheduled_duration_min": t["scheduled_duration_min"],
        "naive_error_min": round(t["naive_flat_speed_min"] - t["scheduled_duration_min"], 1)
        if t["scheduled_duration_min"] else None,
        "model_error_min": t["gap_vs_schedule_min"],
    }
    return res


@app.get("/eta/{train_number}")
def get_eta(
    train_number: str,
    date: str = Query(None, description="Run date, YYYY-MM-DD"),
    weather: str = Query("clear", description=f"one of {list(curvature.WEATHER_SPEED_FACTOR)}"),
    mode: str = Query("vertex", description="curvature application: 'vertex' (physically precise, default) or 'block' (conservative upper bound)"),
    max_speed: float = Query(eta_model.MAX_SPEED_KMH, description="max operating speed km/h"),
):
    """Per-segment breakdown and total predicted ETA."""
    if date:
        try:
            datetime.strptime(date, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(422, detail=f"date must be YYYY-MM-DD, got {date!r}")
    if weather not in curvature.WEATHER_SPEED_FACTOR:
        raise HTTPException(
            422,
            detail=f"weather must be one of {list(curvature.WEATHER_SPEED_FACTOR)}, got {weather!r}",
        )
    if mode not in ("block", "vertex"):
        raise HTTPException(422, detail="mode must be 'block' or 'vertex'")

    try:
        res = _eta_payload(train_number, date, weather, mode, max_speed)
    except FileNotFoundError as e:
        raise HTTPException(
            404,
            detail=(
                f"No cached data for train {train_number}. This build is cache-first; "
                f"prime .cache/ with {train_number}_route.json and {train_number}_live*.json. ({e})"
            ),
        )
    return JSONResponse(res, headers={"Cache-Control": "no-store"})


@app.get("/conflicts/{train_number}")
def get_conflicts(
    train_number: str,
    delay: float = Query(0.0, description="our train's current delay in minutes (carried forward, no recovery assumed)"),
    offsets: str = Query("0,-1,-2", description="departure-day offsets to scan for other trains' instances"),
):
    """
    Crossing & overtake prediction: where this train meets others on single line,
    who takes precedence, and how many minutes the loser stands in a loop.

    Costs **no upstream request**.  Other trains' times come from cached static
    timetables (`.cache/corridor/`, built by scripts/build_corridor.py) — only
    our own delay is live, and it is passed in.

    Every assumption travels with the answer in `_meta`: loop locations are
    assumed (this source has no track-count data), the priority ladder is a
    heuristic over the train type string rather than official IR precedence, and
    the output is decision support for a human controller, never a control action.
    """
    if delay < -720 or delay > 1440:
        raise HTTPException(422, detail=f"delay must be between -720 and 1440 minutes, got {delay}")
    try:
        offs = tuple(int(o) for o in offsets.split(",") if o.strip())
    except ValueError:
        raise HTTPException(422, detail=f"offsets must be comma-separated integers, got {offsets!r}")
    if not offs:
        raise HTTPException(422, detail="offsets must contain at least one integer")

    try:
        import conflict as conflict_mod
        res = conflict_mod.find_conflicts(train_number, delay, offs)
    except FileNotFoundError as e:
        raise HTTPException(
            404,
            detail=(
                f"No corridor cache for train {train_number}. Build it with "
                f"`python3 scripts/build_corridor.py` (offline, no API calls). ({e})"
            ),
        )
    return JSONResponse(res, headers={"Cache-Control": "no-store"})


@app.get("/eta/{train_number}/curvature")
def get_curvature(
    train_number: str,
    lat_min: float = Query(18.4, description="isolation window south bound"),
    lat_max: float = Query(18.6, description="isolation window north bound"),
    max_speed: float = Query(eta_model.MAX_SPEED_KMH),
):
    """Curvature-only view: sharpest curves route-wide + a lat-window isolation."""
    try:
        coords = eta_model.load_route_coords(train_number)
    except FileNotFoundError as e:
        raise HTTPException(404, detail=str(e))

    segs = curvature.build_segment_profile(coords, max_train_speed_kmh=max_speed, weather="clear")
    capped = [s for s in segs if s["capped_speed_kmh"] < max_speed]
    window = [s for s in segs if lat_min <= s["from"][0] <= lat_max or lat_min <= s["to"][0] <= lat_max]
    wcap = [s for s in window if s["capped_speed_kmh"] < max_speed]
    wdist = sum(s["distance_m"] for s in window)
    weta = sum(s["eta_seconds"] for s in window)
    wnaive = curvature.naive_eta(wdist, max_speed) if wdist else 0.0

    # Route-wide penalty at a UNIFORM target speed — i.e. curvature vs `max_speed`
    # everywhere, with no schedule baseline in the way.  This is the only framing in
    # which the curvature layer changes the answer on 22229: /eta takes
    # min(baseline, curve_cap), and the timetable's own 28-77 km/h baselines already
    # sit below the RDSO caps almost everywhere, so there the layer is ~0.  Sweep
    # max_speed here to ask "could this alignment support a faster path?" instead.
    tdist = sum(s["distance_m"] for s in segs)
    teta = sum(s["eta_seconds"] for s in segs)
    tnaive = curvature.naive_eta(tdist, max_speed) if tdist else 0.0

    return {
        "train": train_number,
        "max_speed_kmh": max_speed,
        "geometry_resolution": eta_model.geometry_resolution(coords),
        "rdso_formula": "V = 4.58 * sqrt(R_metres)",
        "binding_radius_threshold_m": round((max_speed / curvature.CURVE_SPEED_CONSTANT) ** 2, 1),
        "total_sub_segments": len(segs),
        "curve_capped_sub_segments": len(capped),
        "route_wide_uniform_speed": {
            "note": (
                "curvature cost if the WHOLE route were run at max_speed_kmh (no schedule "
                "baseline). Sweep max_speed to test whether the alignment could support a "
                "faster path. Not the same as /eta's curvature contribution, which is ~0 "
                "because min(baseline, curve_cap) picks the timetable baseline almost "
                "everywhere."
            ),
            "distance_km": round(tdist / 1000, 1),
            "flat_speed_min": round(tnaive / 60, 3),
            "curvature_capped_min": round(teta / 60, 3),
            "curvature_penalty_min": round((teta - tnaive) / 60, 3),
        },
        "sharpest_curves": [
            {
                "radius_m": s["radius_m"],
                "capped_speed_kmh": s["capped_speed_kmh"],
                "sub_segment_len_m": s["distance_m"],
                "lat": round(s["from"][0], 5),
                "lng": round(s["from"][1], 5),
            }
            for s in sorted(capped, key=lambda x: x["radius_m"])[:10]
        ],
        "isolation_window": {
            "lat_min": lat_min,
            "lat_max": lat_max,
            "sub_segments": len(window),
            "curve_capped": len(wcap),
            "distance_km": round(wdist / 1000, 2),
            "flat_speed_min": round(wnaive / 60, 3),
            "curvature_capped_min": round(weta / 60, 3),
            "true_curvature_penalty_sec": round(weta - wnaive, 2),
        },
    }
