# RailSync — SIH 2026, PS 26028

Dynamic ETA Forecasting & Conflict-Aware Recommendation System for Indian
Railways coaching trains. Internal round presentation: **1 September 2026**.

Read this file fully before doing anything. It contains verified findings —
do not re-derive things marked VERIFIED, build on top of them.

---

## 1. The Problem (PS 26028, Ministry of Railways)

Current ETA prediction (NTES and most apps) = static timetable + current
delay + fixed recovery buffer. It ignores real ground conditions: speed
restrictions, congestion, preceding-train delays, weather, curvature. Errors
compound on long/multi-day journeys and never reach downstream systems
(platform allocation, crew scheduling, cleaning turnaround, feeder transport).

Full PS text, SDGs, and abstract: see `docs/PS26028_abstract.pdf` if present.

---

## 2. Our USPs (in priority order — this is what differentiates us)

1. **Curvature & Weather-Aware Segment Speed Capping** (headline USP).
   Every track segment gets its own physically achievable speed — capped by
   curve radius (not the train's rated max), further reduced for weather —
   instead of one average speed for the whole journey. No existing app
   (NTES, RailYatri, ixigo) or public repo does this.
2. **Tunnel / GPS-Blind-Spot Dead Reckoning.** When live GPS drops, estimate
   position/ETA from last known speed + known tunnel length + historical
   average speed for that specific tunnel, recalibrating instantly on signal
   reacquisition.
3. **Block-Based Conflict-Point Prediction.** Model trains sharing a block
   section as linked nodes (graph, not isolated per-train prediction).
   Predict *where and when* a faster train will be forced to slow behind a
   slower one, and the ETA cost — prediction only, no automated fix
   recommendation (we predict, we do not dispatch/control).
4. **Delay Cascade Modelling.** How a delay in one block propagates
   downstream to following blocks and trailing trains.
5. **Crowdsourced Hazard Reporting + Confidence Mapping.** Passengers report
   hazards (photo + geofenced location). Multi-source verification
   (independent report count, location match against live train position,
   time clustering) before anything escalates from "logged" to "alert."

Tagline: **"Predict the delay. Explain the cause. Prevent the ripple."**

Team name in slides: **Arka!**

### Safety framing (non-negotiable, state this explicitly if asked)
This is a decision-support / information system only. No feature issues
automated commands to train control, signalling, or braking systems. All
conflict alerts and hazard escalations require human confirmation (Section
Controller / Control Room Operator). Do not build or suggest anything that
implies automated train control.

---

## 3. Data Source Strategy (be honest about this, always)

- **Production vision:** RTIS (ISRO/CRIS GPS on locomotives) via CRIS's
  Project Pravah API platform. Not accessible to us — requires official
  Railways authorization.
- **What we actually use for the prototype:** RailRadar
  (https://railradar.in/docs) — free public API, crowdsourced-GPS-based
  (same category as RailYatri/ixigo, NOT equivalent to RTIS). Base URL:
  `https://api.railradar.in/v1`. Auth: `Authorization: Bearer rr_live_...`
  (key in `RAILRADAR_API_KEY` env var). Free tier: 1,000 req/month — cache
  aggressively, check `.cache/` before any API call.
- **Weather:** OpenWeatherMap / IMD public API — genuinely live, no caveat needed.
  **Not yet wired in.** The ETA model currently applies the *static placeholder*
  multipliers in `curvature.WEATHER_SPEED_FACTOR` (clear 1.0, rain 0.85,
  heavy_rain 0.65, monsoon_flagged_section 0.6, fog 0.5). These are untuned
  guesses, not sourced from TSR data — the weather sensitivity numbers are
  illustrative only. Say "weather-capping is implemented, live weather feed is
  the next integration", not "we use live weather."
- **Hazard reports:** fully real, our own new data — genuinely live and demoable.
- Never claim RailRadar data = official Railways data in the pitch. Always
  frame it as "prototype data source, RTIS-ready via Project Pravah in production."

### Reference demo train
**22229 / 22230** — CSMT–Madgaon Vande Bharat Express, Konkan Railway route.
- Distance: 580.6 km (RailRadar) / 588 km (official) — ~1.3% discrepancy, fine.
- Scheduled duration: 635 min (non-monsoon). Monsoon timetable adds ~2h20m.
- Actual rated max speed: 130 km/h. **Actual max operating speed per API: 80 km/h** — use 80, not 130, for this train's calculations.
- Sharpest known curve: R=268m near Panvel/Bhor Ghat (lat ~18.52) → capped
  at 75 km/h. Geographically correct — use this as the standalone
  single-segment demo example.
- Konkan Railway's modern alignment (tunnels + viaducts) bypasses most sharp
  bends, so curvature's effect on this specific route is real but small in
  aggregate — integrated per-vertex it is **+0.0013 min out of 635**, binding on
  a single 80 m sub-segment (VERIFIED #7). **Curvature will matter far more on
  Shimla-Kalka, Araku Valley, or other mountain routes** — mention this when
  discussing generalizability, don't oversell curvature's impact on this one route.

---

## 4. VERIFIED Findings — do not re-derive, build on these

1. **Route geometry field nesting (RailRadar quirk):** coordinates are at
   `payload["data"]["geojson"]["geometry"]["coordinates"]` — NOT
   `payload["data"]["geometry"]["coordinates"]`. There's an extra `geojson`
   wrapper. Same extra wrapper on the `/live` endpoint's geometry field.
   Coordinate order is standard GeoJSON `[lng, lat]`.
2. **1184 coordinate points** for the full route (~0.50 km spacing) —
   dense enough for real curvature calculation.
3. **`speedToNextStationKmph` is 100% SCHEDULE-DERIVED, not live.**
   Confirmed identical across 4+ different dates for 81/82 stations. Does
   NOT equal `distance / scheduled_time_between_consecutive_stops` — it's
   computed per halt-to-halt block and applied uniformly to intermediate
   non-halt stations within that block (per-station distances are rounded,
   causing the mismatch). **Use only as a static per-segment baseline speed.
   Never present it as a live/dynamic signal.**
4. **Delay signal: PARTLY AVAILABLE. Superseded twice — read all of this.**
   - **v1 (wrong):** "delay fields vary meaningfully across dates." False as stated;
     it came from comparing full ISO timestamps that differ only in their **date
     prefix** (`2026-08-08T05:32` vs `2026-08-13T05:32`), not in any delay value.
   - **v2 (wrong to generalise):** "completed runs are all zero-echo, so the
     historical-delay layer cannot be built." True for the 4 dates then cached
     (08-08 / 08-13 / 08-18 / 08-25), which return `trackingMode: "none"`,
     `isLive: false`, `actualArrival == scheduledArrival`, `delayMinutes: 0`.
     **Not true of the tier.**
   - **v3 (current, verified 2026-08-29):** some dates DO carry real actuals.
     Of 9 cached dates, **5 return `trackingMode: "real-time"`** with a non-null
     `delayArrival` at each of the 8 non-origin halts: 08-19, 08-21, 08-24,
     08-26, 08-28. The other 4 remain zero-echo. So it is **per-date, not
     per-tier** — always audit, never assume either way.
   - **Zero-echo dates must be SKIPPED, not averaged in as zeros.** A
     completed-but-untracked run reports 0, and treating that as "ran on time"
     drags the mean toward nothing. `historical_delay_increment_by_seq` drops any
     date whose final halt has a null `delayArrival`.
   - **How to re-check:** count non-null `delayArrival` **and**
     `actualArrival != scheduledArrival` per date *before* averaging anything.
     `fetch_dates.py` and `report_eta.py` Step 3 both do this audit automatically.
   - An **undated** `/live` call returns the *next* scheduled run
     (`status: not-started`) — all-zero because it hasn't departed. Not a bug.
   - **Also genuinely in the data:** the timetable's own recovery margin —
     scheduled block time minus physics-minimum time. For 22229 it totals
     **171 min of the 635** (THVM→MAO alone is paced 64.8% above its physics
     minimum). Independent of the delay signal; still valid.

5. **Naive flat-speed ETA vs actual schedule (635 min):**
   - at **80 km/h**: 588 km → **441 min**, gap **~194 min**
   - at **130 km/h**: 580.6 km → **268 min**, gap **~367 min**
   - **CORRECTED 2026-08-29:** this finding previously read "flat-80km/h ETA =
     269 min … ~366 min gap." Those are the **130 km/h** numbers
     (580.6/130*60 = 268.0; 635−269 = 366), mislabelled as 80 km/h. The
     erroneous pair propagated into at least one task brief — use the table above.
   - The conclusion was and remains correct: the gap is mostly **halt dwell
     time + average operating speed** (55.6 km/h actual vs 80 km/h assumed) —
     NOT primarily curvature on this route. Curvature is real and correctly
     detected, just not the dominant factor on Konkan specifically.
6. **Curvature must be applied per-vertex, not per-block** (methodology,
   verified 2026-08-29). Applying a halt-to-halt block's *sharpest* radius to
   the whole block overstates the penalty by ~2,200×: R=268m covers only ~80 m of
   actual track, but spreading it across all 175 km of PNVL→KHED costs a
   fictitious +3.0 min when the true integrated cost is **0.081 seconds**.
   `eta_model.py` implements both; `mode=vertex` is the **default**, `mode=block`
   is available only as an explicitly-labelled conservative upper bound (correct
   when a data source exposes just one radius per block). **Never present the
   block number as measured physics** — anyone who checks the geometry will find
   the discrepancy.
7. **On 22229, curvature is essentially non-binding — say so** (verified
   2026-08-29). Integrated per-vertex, curvature's total contribution over 588 km
   is **+0.0013 min** (0.08 s). It binds on exactly **one 80 m sub-segment**
   (R=268 m → 75.0 km/h vs the 76.6 km/h block baseline). The reason is
   structural, not a bug: the timetable's own baseline speeds are 28–77 km/h,
   already **below** the RDSO curve caps everywhere else on the route, so
   `min(baseline, curve_cap)` picks the baseline every time.
   - Where the layer *does* earn its place is validating a **proposed faster**
     schedule. At a uniform target speed, curvature costs: 80 km/h → +0.0 min;
     100 → +0.2; 110 → +0.4; 130 → +1.1; 160 → +3.1 min. That is the honest
     framing — "this alignment could not support a 160 km/h path without
     N minutes of curve loss", not "curvature explains today's 635 min".
   - **Do not claim the model is accurate *because of* the physics layer.** Of
     the 194 min the naive model misses, +177 comes from schedule-derived
     baseline speeds and +17 from dwell. Curvature contributes +0.0013 and
     historical delay 0.0.
8. **The route polyline is curvature-blind over 56% of its length** (data
   quality, verified 2026-08-29). Vertex spacing is median 195 m but has 147
   spans over 1 km (max 11.9 km), covering 327.2 of 581.4 km. A 3-point
   circumradius cannot resolve a curve shorter than its own chord, so in that
   56% curvature is **undetectable, not absent**. Worst blocks: RN→KKW and
   KKW→THVM at ~73% blind — the deep-Konkan stretch where real curvature is
   most likely. Median density is uniform, so this is scattered long jumps, not
   a sparse region. Always state the curvature result as *"in the resolvable
   ~44% of the route"*. `eta_model.geometry_resolution()` computes this and both
   API endpoints return it as `geometry_resolution`.
9. **`delayArrival` is CUMULATIVE, not per-segment — never sum it** (bug found and
   fixed 2026-08-29, the moment real actuals arrived). It equals
   `actualArrival - scheduledArrival`, so it already contains every minute lost
   earlier in the run.
   - **What went wrong:** `compute_eta` added it per segment. Summing the 8
     cumulative values for 2026-08-21 gives **+149 min** for a run that finished
     **3 min EARLY** (632 vs 635). The model reported 679.1 min. The bug was
     invisible for as long as every value was 0, then produced a ~64 min error
     the instant the data became real — a zero-valued layer hides its own bugs.
   - **Fix:** difference along the halt chain, per date, then average:
     `increment(b) = cum(b) - cum(a)`. Origin's cumulative delay is its own
     `delayDeparture` (0–6 min in practice). Increments telescope back to the
     end-to-end delay, which is the only delay figure that may be added to a
     schedule-derived running time. `historical_delay_increment_by_seq()` does
     this; `historical_delay_by_seq()` still returns the cumulative view and is
     correct **only** for "how late at station X" reporting.
   - **Quote `end_to_end_delay_mean_min`, not the sum of increments.** They differ
     by −2.5 min here because DR and THVM each miss one date, so a sum-of-means
     diverges from a mean-of-sums. Both are in the API's
     `historical_delay_audit` block along with `coverage_artifact_min`.
   - **22229 runs EARLY on average: −19.6 min** over the 5 tracked dates
     (−43, −3, −33, −20, +1). The delay layer *subtracts* time. Do not assume
     an Indian Railways delay model only ever adds.
10. **The model now validates against observed runs, not just the timetable**
    (2026-08-29). Keep these two comparisons separate in the pitch:
    - **vs timetable (635 min):** 634.9 min. This is near-circular — the baseline
      speeds *are* the timetable, so reproducing it is arithmetic, not skill. Use
      it only as a wiring check.
    - **vs observed runs (615.4 min mean, 5 dates):** vertex model 612.8 min,
      **error −2.6 min**; naive flat-80 is off by −174 min. This is the real
      validation and the number worth showing.
    - **Always report the band, not just the mean.** Observed journeys were
      592 / 632 / 602 / 615 / 636 min — a **44 min spread**. A single mean hides
      that. One accuracy number off a 5-sample mean with a 44 min spread would
      oversell the model.

---

## 4b. Verified model numbers for 22229 (2026-08-29, after the delay fix)

| Model | ETA | vs 635 sched | vs 615.4 observed |
|---|---|---|---|
| Naive flat 80 km/h | 441.0 | −194.0 | −174.4 |
| + schedule baseline speeds | 617.9 | −17.1 | +2.5 |
| + curvature, `mode=vertex` (default) | 617.9 | −17.1 | +2.5 |
| + halt dwell | 634.9 | −0.1 | +19.5 |
| **+ historical delay → FINAL (vertex)** | **612.8** | **−22.2** | **−2.6** |
| (same, `mode=block` upper bound) | 615.7 | −19.3 | +0.3 |

Layer contributions: baseline speeds **+177 min**, dwell **+17 min**, historical
delay **−22.1 min**, curvature **+0.0013 min**. The delay layer is the only one
carrying information the timetable does not already contain.


---

## 5. Verified Files (already built and tested — extend, don't rewrite from scratch)

- **`railradar_client.py`** — `RailRadarClient` class.
  - `get_live_status(train_number, date=None, geometry=True, geometry_format="geojson", include_coordinates=True)`
  - `get_route_geometry(train_number)`
  - `get_trains_between(from_code, to_code)`
- **`curvature.py`** — curvature-based speed capping.
  - `build_segment_profile(geojson_coords, max_train_speed_kmh, weather="clear")` → list of segment dicts (distance_m, radius_m, capped_speed_kmh, eta_seconds)
  - `total_segment_eta(segments)`
  - `naive_eta(total_distance_m, avg_speed_kmh)`
  - Formula: `V(km/h) = 4.58 * sqrt(R_metres)` (RDSO broad-gauge approximation), then weather multiplier from `WEATHER_SPEED_FACTOR` dict.
  - Note: `build_segment_profile` returns `n-2` segments for `n` coords (it needs
    a 3-point window per radius), so its distance sum is ~581 km, slightly under
    the 588 km schedule figure. Expected, not a bug.
- **`eta_model.py`** — the combined Phase 3 model (cache-only, no API calls).
  - `compute_eta(train, date=None, weather="clear", max_speed=80)` → per-segment
    breakdown + totals, JSON-serialisable.
  - `snap_halts_to_vertices(coords, halts)` → halt→vertex anchoring (see below).
  - `sharpest_radius_in_block(coords, i0, i1)` → min radius in a vertex range.
  - `block_vertex_running_min(...)` → per-vertex curvature integration, per-block
    renormalised (VERIFIED #6). The older km-range `vertex_running_min` /
    `sharpest_radius_in_range` remain for compatibility but use the global-scale
    axis — prefer the block/index versions.
  - `geometry_resolution(coords)` → curvature-blind fraction (VERIFIED #8).
  - Each segment carries `baseline_only_min`, `vertex_curve_penalty_min` and
    `vertex_curve_penalty_sec` so the curvature layer is auditable on its own.
  - `historical_delay_by_seq(train)` → mean `delayArrival` per stop; currently 0.0
    everywhere (VERIFIED #4).
  - Per halt-to-halt segment:
    `eta = distance / min(baseline, curve_cap, weather_cap) + hist_delay + dwell`
  - Dwell is counted at the **arriving** halt of each segment, so the origin is
    excluded and no halt is double-counted (17 min total for 22229).
- **`report_eta.py`** — 9-step layer-by-layer verification report. Prints every
  intermediate number (baseline vs hand-calculated speed, per-block radii, the
  delay audit, dwell, block-vs-vertex comparison, before/after table, ghat
  isolation, weather sensitivity). Run this to re-verify any layer.
- **`api.py`** — Phase 4 FastAPI wrapper. `GET /eta/{train}?date=&weather=&mode=`,
  plus `/health` (per-date real-signal vs zero-echo audit), `/eta/{train}/curvature`,
  `/dashboard` (serves `dashboard.html`) and `/geometry/{train}?max_points=` (polyline
  for drawing; stride-decimated but every halt vertex forced in, each with a
  `point_index` — curvature never uses the decimated set).
  In `mode=vertex` each segment also carries `effective_speed_applied_kmh`, the block's
  *mean* vertex-integrated speed. Without it `distance / running_min_applied` does not
  reconcile with `effective_speed_kmh` (which is the block-mode number) and the
  breakdown reads as self-contradictory.
  Start with: `python3 -m uvicorn api:app --reload --port 8000`
- **`dashboard.html`** — Phase 8 UI. Static, dependency-free, reads only the endpoints
  above. See the Phase 8 entry in §6 for the honesty wiring that must stay in it.
- **`fetch_dates.py`** — cache-first historical-date fetcher. Computes valid
  Mon/Wed/Fri run-dates, skips what's cached, fetches only the gaps, then
  re-audits every cached run for a real delay signal. Run this when you want
  more dates; it degrades gracefully with no network.

### Verified model numbers for 22229 — SUPERSEDED, see §4b
This table predates the delay fix (VERIFIED #9) and is kept only to show what the
model looked like when the delay layer was 0.0. **§4b has the current numbers.**
| Model | ETA | vs 635 min |
|---|---|---|
| Naive flat 80 km/h | 441.0 | −194.0 |
| + schedule baseline speeds | 617.9 | −17.1 |
| + curvature, `mode=vertex` (default) | 617.9 | −17.1 |
| + historical delay (0.0 at the time) | 617.9 | −17.1 |
| + halt dwell | 634.9 | −0.1 |
| (same, `mode=block`) | 637.8 | +2.8 |

Baseline speeds reproduce the timetable exactly (618 min running + 17 min dwell
= 635 min), which is the check that each layer is wired up correctly.

**The −0.1 min residual was never predictive skill.** It sits at the rounding floor
of the timetable's own integer-minute arrivals. Do not compute an "N× more
accurate than naive" ratio off it — dividing 194 by ~0.1 produces a meaningless
four-figure number. With real actuals now cached, compare against **observed runs**
(§4b) instead; that comparison is not circular.


**Geometry alignment (fixed 2026-08-29).** Each halt is snapped to its nearest
geometry vertex by its own lat/lng (`eta_model.snap_halts_to_vertices`), then each
block's sub-segment lengths are renormalised to that block's timetable distance.
This replaced a single global 581.4→588 km scale factor which smeared the 6.6 km
mismatch across all blocks as ±0.5 min of noise — enough that the vertex row used
to sit *below* baseline-only, implying curvature made the train faster. The fix
makes the invariant exact: **vertex running time can never be less than
baseline-only**, so any difference it reports is curvature and nothing else.
Verified: penalty ≥ 0 on all 8 blocks, block distances sum to exactly 588 km.
Snap error is ≤800 m (platform vs track centreline), i.e. 1–2 vertices on blocks
of 9–175 km — immaterial, but indices are forced monotonic rather than trusted.

---

## 6. Build Phases

- [x] **Phase 0:** RailRadar signup, key working, confirmed real data returns.
- [x] **Phase 1:** `railradar_client.py` — live status + route geometry fetch.
- [x] **Phase 2:** `curvature.py` — curve-radius speed capping, verified against known geometry and real route data.
- [x] **Phase 3:** Combined ETA model (`eta_model.py`, verified by
      `report_eta.py`) — merges (a) schedule-derived baseline speed per segment,
      (b) curvature/weather cap (takes the min), (d) halt dwell time. Compared
      against the real 635 min schedule: **634.9 min, −0.1 min error (0.01%)**
      vs naive flat-80's −194 min. Note that accuracy comes from layers (a) and
      (d); the curvature layer contributes +0.0013 min (VERIFIED #7).
      **(c) historical average delay per segment is BLOCKED** — the data source
      returns zero-echo for completed runs (VERIFIED #4). The layer is
      implemented and returns 0.0; it activates automatically if real actuals
      appear. Comparison "against real observed delayed runs" is likewise not
      possible from this source — re-run `fetch_dates.py` then `report_eta.py`
      if that ever changes.
- [x] **Phase 4:** Combined model wrapped in FastAPI (`api.py`):
      `GET /eta/{train_number}?date=YYYY-MM-DD&weather=&mode=` returning
      per-segment breakdown + total ETA + predicted arrival clock time (JSON).
      Also `/health` and `/eta/{train}/curvature`. All routes verified
      end-to-end via `fastapi.testclient` including 422/404 paths.
- [x] **Phase 8 (done, built out of order — needed something visible for 1 Sep):**
      `dashboard.html`, served by `GET /dashboard`, plus `GET /geometry/{train}` for the
      polyline. Single static file, no build step, no npm, **no CDN** — every number is
      fetched live from `/eta`, `/geometry` and `/health` and nothing is hardcoded.
      - **Not a tiled map.** There is no network egress in this environment, so Mapbox
        would render blank. The route is inline SVG drawn from the real 1184-vertex
        polyline, north-up, viewBox sized from the data aspect (a fixed wide box flattens
        a 3.9°-latitude corridor into a smear). Halt labels alternate sides and are
        decluttered per side by sorting on y — CSMT→DR→TNA→PNVL doubles back, so latitude
        is **not** monotonic along the journey and four labels land in a ~32 px band.
      - Panels: KPI row, route SVG, per-segment table, layer-contribution ladder,
        historical-delay panel (5 per-date bars + spread + coverage artifact), curvature
        panel, build status.
      - `weather` and `mode` selectors re-query the API live. Verified: clear/vertex
        612.8, clear/block 615.7, heavy_rain 718.2, fog 923.2 min.
      - **Honesty wiring that must not be removed:** the prototype-data-source and
        no-automated-control banner; the untuned-placeholder warning whenever
        `weather != clear`; the `n=` sample count per delay cell and the sum-of-means
        explanation for the −2.5 min coverage artifact; the "resolvable ~44%" caveat on
        every curvature figure; and the `curve +` column renaming itself to `curve+wx +`
        under non-clear weather, because `vertex_curve_penalty_min` has the weather factor
        folded in and is **not** curvature-only there.
      - Phases 5/6/7 appear in Build Status as `NEXT`/`TODO` only. Never render conflict
        alerts or hazard pins as if they work.
      - Still to do here: WebSocket auto-refresh, live speed badge.
- [ ] **Phase 5 (current):** Block-level conflict-point prediction (needs a second
      train's live data on a shared/crossing section — use
      `get_trains_between()` to find candidates).
- [ ] **Phase 6:** Dead reckoning for GPS-blind zones (tunnel length +
      last-known speed; needs static tunnel-location data for the demo
      corridor — source from public alignment docs).
- [ ] **Phase 7:** Crowdsourced hazard reporting + confidence scoring
      (independent of live data — can be built in parallel anytime).

---

## 7. Tech Stack (as pitched — stay consistent with this in the deck)

- **Data:** RailRadar API (prototype) → RTIS/CRIS Project Pravah (production vision), OpenWeatherMap/IMD, public historical datasets for training buffer.
- **ML:** XGBoost/LightGBM (baseline), LSTM (sequence), graph model (cascading delay/conflict), curvature calc (this repo).
- **Backend:** Python FastAPI, REST + WebSocket (push-based live updates, not polling), PostgreSQL + TimescaleDB, Redis (cache + pub/sub).
- **Frontend:** React/Next.js, Mapbox GL/Deck.gl, WebSocket client, auto-updating (no manual refresh).
- **Infra:** Docker.

---

## 8. Working Style / Constraints

- **Cache-first, always.** Check `.cache/` before any RailRadar API call —
  free tier is 1,000 req/month.
- **Print intermediate numbers, don't just report final results.** Every
  layer (baseline speed, curvature cap, historical delay, dwell time) needs
  to be independently verifiable before trusting the combined total — this
  project has already caught one false lead (`speedToNextStationKmph`) by
  checking raw numbers instead of trusting a plausible-sounding field name.
  Keep that discipline.
- **Never claim a data source or capability we don't have** (e.g. don't say
  "live RTIS integration," don't invent unsourced statistics for the pitch deck).
- **No automated control anything.** Every recommendation/alert is
  human-confirmed. Don't build toward or imply automated train control.
