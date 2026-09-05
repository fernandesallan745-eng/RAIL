# GATI — SIH 2026, PS 26028

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
11. **Tunnel portals must be projected PERPENDICULARLY onto the polyline, never
    snapped to the nearest vertex** (verified 2026-09-01, Phase 6). Vertex spacing
    on this route is median ~195 m but runs to 11.9 km (VERIFIED #8), so
    nearest-vertex snapping puts **both portals of a short tunnel on the same
    vertex** — the tunnel gets zero chainage length and containment can never
    fire. Measured: vertex snapping gave portal offset **median 155 m / max
    2517 m** and collapsed **18 of 69** tunnels to zero length; clamped-`t`
    perpendicular projection gives **median 1 m / max 10 m** and **0 of 69**
    degenerate. On the live 12051 projection the offsets are 0.2–0.5 m.
    - This also **retracts two premises** from the Phase 6 plan. "Snap error
      median 56 m, p90 762 m, max 2517 m" was vertex quantisation, not
      disagreement between OSM and RailRadar — the portals sit essentially *on*
      RailRadar's alignment. And "along-track is worse — Tike +31%" was an
      artifact of the same method; with projection Tike's along-track/chord ratio
      is 1.00, so the two length bases **corroborate** each other rather than
      conflict. Chord stays the published number only because it depends on the
      portal coordinates alone, independent of vertex density.
12. **`currentLocation` has no lat/lng — the train's position is on the TIMETABLE
    axis, and tunnel chainage is on the POLYLINE axis** (verified 2026-09-01).
    The two differ by 551 m on 12051 and 6604 m on 22229. The Konkan **median
    tunnel is 593 m**, so comparing the axes directly misplaces the train by more
    than a whole typical tunnel. `tunnels.js` renormalises per block using route
    stations as anchors — the same correction `eta_model.snap_halts_to_vertices`
    applies to halts, for the same reason.
    - **Measured worth of the renormalisation:** on 22229 (81 anchors) anchored
      vs global-scale chainage differ by **median 655 m, max 1576 m**, and
      **41 of 69** tunnels shift by more than their own length. Without it most
      tunnels would be misidentified.
    - `projectTunnelsOntoRoute` reports `axisBasis: 'station-anchored' |
      'global-scale' | 'unavailable'` and the UI renders a warning for anything
      but the first. It degrades **loudly**, never silently.
13. **`includeCoordinates: true` is required on the live call, and the drawer path
    was not sending it** (found and fixed 2026-09-01). Without it RailRadar omits
    station lat/lng, so there is nothing to anchor to and the tunnel layer falls
    back to one global scale factor. It is a parameter on a call we already make,
    so it costs **no extra upstream request**.
    - The fleet path (`railradar.js`) and the drawer path
      (`train.controller.js:86`, which spread `req.query` straight through) are
      **two separate call sites** — fixing only the service left the drawer
      broken. Verified before/after on live 12051: `stationsWithLatLng` 0 → 87,
      `axisBasis` `global-scale` → `station-anchored`, `anchorCount` 0 → 87.
14. **On Konkan, tunnel geometry is genuinely load-bearing — unlike curvature.**
    69 tunnels, **65.6 km of bore over 582 km = 11.3% of the route underground**,
    median 593 m, longest Karbude at 6535 m (India's longest rail tunnel).
    Karbude's transit at the schedule-derived block speed of 55.8 km/h is
    **~7.1 min**. Contrast VERIFIED #7, where curvature contributes +0.0013 min:
    the tunnel layer is the one physical-geometry feature on this specific route
    with an effect big enough to matter.
15. **Crossing prediction needs the other trains' SCHEDULES, not their live data —
    the Phase 5 blocker was a false premise** (verified 2026-09-05). Phase 5 sat
    blocked on "needs a second train's live data". It does not. A meet point falls
    out of two timetables plus *our* delay, so the whole layer runs on
    `.cache/` at **zero additional upstream requests**. The user's original
    pseudocode called `get_live_status(other)` inside a loop over ~15 candidates,
    which would trip the 10 req/min ceiling and burn ~1.5% of a monthly key per
    evaluation. **Do not poll other trains.**
    - Corridor: **17 trains** already cached with complete schedules. The glob
      matches **18** files — `fleet_fallback.json` is a fleet array, not a train,
      and must be skipped **by name**, not by shape.
    - Opposing pairs share the corridor exactly: 12051/12052 share **87/87**
      stations with mirrored chainage (`downKm = 582.3 − upKm`, ±0.1 km). Station
      **code** is a perfect join key. Goa Express 12779/12780 shows only **3**
      shared stations — it routes via Londa, a good negative control.
16. **Cached runs span four service dates, so times MUST be day-normalised —
    absolute timestamps are not comparable** (verified 2026-09-05). Use
    `(day − 1) * 1440 + hh*60 + mm` from `arrivalDay`/`departureDay`. Do **not**
    read the ISO date prefix: it is the cached run's own service date, not the
    journey day, and comparing raw ISO strings finds nothing.
    - **Multi-day instances are mandatory, not an optimisation.** 12617, 16346 and
      01132 occupy our corridor on **their own day 2** — they departed yesterday.
      Scanning departure offsets `(0, −1, −2)` finds **5** crossings for one run of
      12051; scanning only offset 0 finds **2**. Skipping them loses 60%.
17. **The single-line boundary is Roha, and it must be anchored by station CODE,
    not a km constant** (verified 2026-09-05). CSMT→**Roha** is Central Railway
    **double line** — a meet there needs no hold and must be reported as such, not
    as a conflict. Without the filter 10103 gains a spurious hold at km 102.7
    (PEN–KASU). Roha is km **142.2** on a down train but km **440.0** on an up
    train, so a hardcoded 142.2 silently inverts the section for every up train.
    `single_line_span()` sorts the ROHA/MAO anchor chainages, making it
    direction-agnostic; the constant survives only as a fallback.
18. **`train.type` is inconsistently formatted and the priority ladder's rule
    ORDER is load-bearing** (verified 2026-09-05). Observed for one thing:
    `MAIL EXPRESS`, `MAIL/EXPRESS`, `Mail/Express`; also `SUPERFAST` vs
    `Superfast Express`. `train.category` is useless for precedence — 3 values
    only (Premium/Express/Special), collapsing Superfast into Mail/Express.
    - `'JAN SHATABDI'` **contains** `'SHATABDI'`, so a substring ladder matched in
      the wrong order gives Jan Shatabdi (rank 3) Shatabdi's rank 2 and it starts
      winning crossings it should lose. Longest-match-first, and
      `verify_conflicts.py` asserts the ordering rather than trusting it.
    - The ladder is **our heuristic over a type string, not official IR
      precedence.** Real precedence is a Section Controller's judgement.
19. **Same-direction overtakes are ZERO on the scheduled timetable — the feature
    is delay-conditional and must be described that way** (verified 2026-09-05).
    Across every cached pair, zero. Structural, not a bug: the timetable departs
    faster trains first (VB 05:25 @55 km/h, Shatabdi 05:10 @50.6, Mandovi 07:10
    @39.5) precisely because an overtake costs a long loop occupancy on single
    track. 22229 needs **+150 min** before it catches 10103, and the point then
    moves with the delay: km 175.3 (+150) → 233.2 (+180) → 341.3 (+240).
    - So an overtake has **no on-time counterpart to have moved from**. The payload
      distinguishes the two cases (`existsOnTime`): a head-on meet *shifts*
      (`shiftKm`, and 12051 +45 min moves all five 12–20 km earlier), an overtake
      is *created*. Conflating them would let the UI claim a planned crossing
      relocated when none was ever planned.
    - It will show nothing in normal running. **That is the correct result**, not a
      wiring failure — say so rather than tuning until something appears.
20. **In an overtake the train being PASSED takes the loop, regardless of the
    priority ladder** (bug found and fixed 2026-09-05). Two bugs in a row here,
    both caught by one number being implausible rather than merely wrong:
    - **Bug 1:** the sign flip in `gap = our_time − their_time` locates the meet,
      but its *direction* says who passes whom. Treating every flip as "we pass
      them" made 12051 overtake 12618 when 12618 was passing us. And precedence
      does not decide the loop: you cannot pass on single line unless the slower
      train is standing aside, whatever its rank. The ladder only decides whether
      a controller grants the pass at all — surfaced as `precedenceNote`.
    - **Bug 2:** a gap of exactly **0** is the *normal planned* crossing (both
      trains timetabled to the same minute — 12051 and 12618 at KFD, 09:30). A
      naive `(g0 < 0) != (g1 < 0)` test detects that meet from **both**
      neighbouring intervals and mislocates it. The half-open test
      `(g0 < 0 <= g1) or (g0 > 0 >= g1)` is required.
    - **How both were caught:** the reported hold was exactly `REACCEL_MIN`
      (3.0 min) — a zero wait plus the constant, which is physically impossible
      for a train that had to stop. A hold that lands exactly on a modelling
      constant is a bug signature, not a result.
21. **The conflict block is DERIVED from a live delay and must never be persisted
    to the disk fallback** (found and fixed 2026-09-05). `train.controller.js`
    writes `enhancedData` to `.cache/train_<n>_live_fallback.json`, and once the
    conflict layer was attached there, the persisted copy carried a prediction
    computed against a delay that would no longer be current when the file was
    re-served — meets at the wrong km, against the wrong train, with nothing in the
    payload saying so. The persist block now strips `conflicts` /
    `conflictsUnavailable`, and the fallback path **recomputes** from the file's own
    `delayMinutes` (free — corridor schedules are static) and labels it
    `delayBasis: 'cached'`, which the panel renders as *"at a cached delay"*.
    - The `delete` before that recompute is not redundant: `enhanceLiveData`
      spreads the fallback object through, so an older cache file's stale block
      would survive a *failed* recompute — and the panel only consults
      `conflictsUnavailable` when `conflicts` is **absent**.
    - Same class of hazard as VERIFIED #9: a derived value that looks right until
      the input behind it moves.

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

## 5b. Node/Express proxy + Leaflet live map (primary demo UI, added after Phase 8)

The Python FastAPI (`api.py`, port 8000) is now fronted by a **Node/Express
server (port 5050)** that serves a Leaflet map UI and proxies RailRadar. Both
processes are needed for the demo, and `npm run dev` now starts **both** via
`scripts/serve.js` (SIGTERM tears down the sibling, so Ctrl+C stops the pair):

```bash
npm run dev            # BOTH: Python ETA model on :8000 + Node proxy/UI on :5050
```

To run them separately for troubleshooting — and this is what `.claude/launch.json`
does, so the two panes don't both try to bind :8000:

```bash
python3 run_server.py 8000                         # ETA model (curvature/delay/dwell)
npm run server                                     # Node proxy + Leaflet UI on :5050
```

Open **http://localhost:5050**. The Node layer calls FastAPI at
`http://127.0.0.1:8000/eta/{train}` and attaches the result as `curvatureEta`
on the live-status payload, so the curvature/delay ETA is the *same* model
documented above — just surfaced through the map UI instead of `dashboard.html`.
`dashboard.html` (served by FastAPI `/dashboard`) still exists as the analytical
static view; the Leaflet UI is the live-tracking view.

**Port 5050, not 5000 — do not "fix" this back.** On macOS, port 5000 is held by
**ControlCenter (AirPlay Receiver)**, which answers with HTTP 403; Chrome renders
that as *"Access to localhost was denied"*, which reads like a server bug but is
not one. GATI never binds it. `.env` and `.claude/launch.json` both say 5050 and
must be changed together — the harness's `PORT` env var overrides `.env`, because
dotenv does not overwrite pre-set variables. `server.js` still auto-increments on
`EADDRINUSE`, so **read the startup banner** rather than assuming the port.

**Files (under `src/` and `public/`):**
- `src/server.js` — Express bootstrap; serves `public/`, mounts `/api`, auto-
  increments the port on `EADDRINUSE`.
- `src/config/env.js` — loads **all** `RAILRADAR_API_KEY=` lines from `.env`
  into `apiKeys[]`. `PORT` defaults to 3001 in code, but the demo `.env` sets
  **5050** (and so does `.claude/launch.json`; `verify_integration.py` defaults
  to 5050 and takes an override argument). Also owns the demo posture:
  `CACHE_TTL_LIVE=0` (live is **never** cached), `FLEET_TRAINS=12051`,
  `FLEET_MAX_TRAINS=1`, and the upstream scheduler settings. It prints a
  `[Posture]` line on boot so the running configuration is never a guess.
- `src/services/railradar.js` — axios client behind a **single global upstream
  scheduler**: ≤9 request starts per trailing 60 s (RailRadar's real limit is 10
  **req/min** — that ceiling, not the 1,000/month tier, is what every 429 in this
  project's history actually hit), concurrency 1, ≥1500 ms spacing as a burst
  smoother only, equal-jitter exponential backoff, and a global 429 cooldown
  shared by the fleet poll, the drawer poll and route fetches. **Key rotation is
  the LAST resort, after backoff on the current key — not load balancing.**
  Rotating on the first 429 was actively harmful: the limit is per unit time, so
  it spreads one overrun across five keys and burns five monthly budgets instead
  of waiting a few seconds. A separate monthly per-key quota guard (1000/key)
  refuses requests at the budget rather than hitting a wall of 429s mid-demo.
  - **One exception, added 2026-09-04: a MONTHLY quota wall rotates immediately.**
    429 covers two different failures behind one status code and they need
    opposite responses — a per-minute burst limit clears in seconds (back off), a
    monthly allowance does not reset until next month (backoff can never recover
    it, so waiting just burns the demo clock). The only way to tell them apart is
    the upstream's own wording, so the interceptor sets
    `customError.isMonthlyQuota` by matching `"monthly quota"` in the raw message
    and **preserves that message** instead of overwriting it with the generic
    rate-limit string. `sendUpstream` then marks the key spent and rotates without
    retrying. **Verified live 2026-09-04:** key #0's monthly allowance really is
    exhausted, the path fired, and the fleet call succeeded on key #1.
  - The interceptor also reads the reason from all three shapes RailRadar uses
    (`{error:{message}}`, `{message}`, bare-string `{error}`) — the nested form
    was previously missed, so the 429 text could not be matched at all.
  `getLiveFleet()` fans out over `config.fleet.trains` — **one train (12051) by
  default**, capped by `FLEET_MAX_TRAINS`, not the old hardcoded 20-train list.
  Because live data is uncached, **fleet size IS the per-poll request count**, so
  each train added costs another request per poll. It interpolates each train's
  live position along its polyline.
- `src/services/tunnels.js` — **Phase 6 tunnel engine.** Projects the 69 real
  Konkan tunnels onto a train's chainage axis and answers "which tunnel is the
  train in, and how long until it comes out." `projectTunnelsOntoRoute()`,
  `findTunnelState()`, `blockSpeedAtKm()`, `tunnelCoverage()`. See VERIFIED
  #11–#13 for the two findings that make it work (perpendicular projection, not
  vertex snapping; per-block axis renormalisation).
- `src/services/deadReckoning.js` — `enhanceLiveData()` attaches **two
  independent blocks**: `liveData.tunnels` (always, whenever the route projects —
  tunnel identity does not depend on the signal being stale) and
  `liveData.deadReckoning` (only when GPS is stale >3 min). Containment-based,
  not proximity-based. **Honesty:** tunnel geometry is now **real** (OSM way
  data, chord within 1.1% of published KRCL figures) but is *not* official KRCL
  alignment data; time-to-exit uses the **schedule-derived** block speed because
  VERIFIED #3 means no live speed exists in this source, and the basis label
  travels with the number so the UI can never render the minutes alone.
  `speed-history.json` is still empty (EMA recalibration has never run).
  Every invented number that used to live here is gone — `signalDropProbability`,
  the `|| 40` and `|| 50` speed defaults, the `remainingKm = 20` fallback and the
  zone-match confidence boost. The path now returns `null` /
  `unavailableReason` instead of fabricating a value.
  `src/data/tunnel-zones.json` (25 hand-written zones, coordinates wrong by up
  to ~93 km) was **deleted**, not merely unwired — it named the wrong tunnel.
- `src/controllers/train.controller.js` — orchestrates live-status + route +
  FastAPI ETA, and **falls back to `.cache/` (in-memory then disk)** on upstream
  429/failure so the demo survives a quota wall or offline network.
- `src/middleware/cache.js` — node-cache TTL layer (live 300s, static 86400s);
  `?refresh=true` or an `x-refresh` header bypasses it.
- `public/index.html` + `public/app.js` — Leaflet UI (Esri satellite / CartoDB
  dark / OpenRailwayMap tiles). **Offline-capable pipeline, pack not bundled** —
  see the offline map pack below. Auto-refresh polls the **server** (fleet 60s,
  selected train 20s) but does **not** send `?refresh=true`, so the 300s server
  cache shields the RailRadar free tier — see the throttle notes in `app.js`.
  - **Tunnel overlay (Phase 6):** `tunnelsLayer` draws all 69 tunnels as segments
    *of* the route line — amber dashed for a tunnel the train is not in, solid
    cyan for the one it is inside. `renderTunnelPanel()` drives one panel with
    three states: "next tunnel in N km" (normal running), "IN TUNNEL" (cyan), and
    "SIGNAL DROPPED" (red). **Colour tracks the SIGNAL, not the tunnel** — red is
    reserved for "we have lost the train", the condition an operator must act on;
    a train can be inside a short bore with a perfectly fresh fix.
  - The client does **no chainage arithmetic of its own** — every number comes
    from `src/services/tunnels.js`. Duplicating the axis correction here would let
    the two drift.
  - `liveData.tunnels.list` (~21 KB) rides on the drawer's live response. It is
    generated from the memoised projection at zero upstream cost, and the fleet
    endpoint never calls `enhanceLiveData`, so a wider fleet does not multiply it.
    It cannot be split into a static endpoint: `entryKm`/`exitKm` are on *that
    train's* timetable axis.
- `public/offline-tiles.js` — `createOfflineLayer()`, an offline-first
  `L.TileLayer`. Requests `/tiles/<layer>/{z}/{x}/{y}.png` first and falls back
  to the CDN **per tile**, so a partial pack works and a full pack needs no
  network. Leaflet itself is loaded local-first (`/vendor/leaflet/`), with the
  unpkg CDN injected dynamically (SRI kept) only if that 404s — *not* via
  `document.write`, which Chrome may block outright on the slow connections this
  feature exists for. A vendored copy makes the shell fully offline.
  **Manifest-gated:** `loadPackManifest()` reads `/tiles/pack.json` once at
  startup, and only layers listed there attempt a local tile. Without it every
  tile ate a guaranteed 404 first (~350 console errors per load); measured after
  the change, a pack-less load makes **1** local request instead of ~350, and
  `maxNativeZoom` comes from the manifest so there is **no constant to hand-edit**
  in `app.js`. `app.js` awaits the probe before `initMap()`.
- `fetch_tiles.py` — builds the pack into `public/tiles/`. Cache-first and
  resumable (existing tiles are skipped); `--dry-run` prints per-zoom tile counts
  and a size estimate with **no** network access. Writes/merges `pack.json` on
  every run that leaves tiles on disk — including the "already complete" early
  exit, so a deleted manifest self-heals. The manifest records the preset *name*,
  never the URL template, which carries the API key (`/tiles/pack.json` is
  publicly served).

### Offline map pack — current state (be precise about this)
The **pipeline is built and verified; the tile bytes are not present.** Nothing
in `public/tiles/` or `public/vendor/` is committed (both gitignored), and the
dev sandbox has no network egress, so the bytes cannot be fetched there. Until
someone runs the two commands in README → "Offline map pack" on a networked
machine, **the map has no local tiles and the CDN serves it exactly as before.**
Say "the map degrades gracefully and can be packed offline", never
"the map works offline" — that is only true after the pack is built.

Verified end-to-end 2026-08-30 with a synthetic pack (172 stub tiles at z4–z8,
built via a `file://` `--url-template` since the sandbox blocks tile hosts, then
deleted): the manifest was detected, `maxNativeZoom` auto-set to 8, the basemap
painted from `public/tiles/` while `satellite-labels` (absent from the pack) went
straight to Esri with zero local requests, and zooming to z11 clamped to z8 and
upscaled rather than going blank. Pack-less load: 0 local tile requests, 36/36
tiles from CDN.

`fetch_tiles.py` **refuses** to bulk-download from Esri, CARTO and
OpenRailwayMap: displaying those tiles interactively is fine, bundling them to
disk breaks their terms. Use a provider that permits offline caching (MapTiler /
Stadia / Thunderforest presets, keyed) or `--url-template`. The `osm` preset is
gated to ≤5,000 tiles at concurrency 1 per the OSMF Tile Usage Policy. Verified
default corridor plan (lat 12.5–19.3, lng 72.6–75.1): **z6–z11 = 855 tiles
≈ 18 MB, z6–z12 = 3,204 tiles ≈ 69 MB** at 22 KB/tile.

**Honesty carried over from §3/§8:** the fleet popup labels speed as
"Speed (sched)" because it comes from `speedToNextStationKmph` (VERIFIED #3 —
schedule-derived, not live GPS). Weather multipliers remain the untuned
placeholders in `curvature.WEATHER_SPEED_FACTOR`.

---

## 5c. Konkan tunnel dataset — provenance and known defects (Phase 6)

Built by **`build_tunnels.py`** (offline, no API calls, no network) from a
user-supplied CSV of OpenStreetMap way geometry, into
`src/data/konkan-tunnels.json`. Run `python3 build_tunnels.py --dry-run` to
re-audit without writing. It prints every intermediate number per §8.

**69 tunnels, 65.6 km of bore, chainage 193.0 km (Dasgaon) → 552 km (Old Goa)**
of a 582 km route. Lengths: min 108 m, **median 593 m**, max 6535 m (Karbude).

**Source is OSM, not KRCL.** `OSM Way Segments` is `1` for every row, and
`_meta.sourceIsOfficial` is `false`. Say "OpenStreetMap way geometry, validated
against published KRCL lengths", never "official alignment data".

**The CSV has no length column** — length is derived. Chord (portal-to-portal
great circle) validates against the 5 tunnels with public KRCL figures to
**≤1.09%**: Karbude 6535 vs 6506, Natuwadi 4409 vs 4387, Tike 4087 vs 4077,
Savarde 3410 vs 3447, Berdewadi vs 4000.

**Two different lengths exist and must not be mixed in the UI.** `chordLengthM`
is the straight line between portals (the published number). `chainageLengthM`
is the tunnel's span on *that train's* timetable axis, and it is what
`metresIn` / `metresToExit` are measured against. They differ by 0.5% on 12051
but 3.7% on 22229 (whose polyline↔timetable mismatch is 6.6 km), so Karbude
reads 6535 m chord / 6778 m chainage there. `renderTunnelPanel` shows the axis
length alongside the chord whenever they differ by >2% — otherwise "6.53 km"
followed by "6777 m to exit" looks like an arithmetic error.

**Defects recorded, not silently fixed** (all in `_meta`):
- **Duplicate `#66`** — Pernam (lat 15.71) and Sherpe (16.53) share it.
- **Numbers 67, 68, 69 are absent.** One of the #66 pair most likely belongs in
  that gap, but *which* is not inferable from the CSV. Both rows are kept and
  **neither is renumbered**. Do not invent the missing three.
- **`36A` is a legitimate tunnel number**, so `Tunnel No` is a **string**.
  `int()` on it raises — this actually happened.
- **CSV row order is not chainage order** (Pernam is filed before Sherpe). Output
  is sorted by chainage; `_meta.order` records that.

---


## 5d. iOS app wrapper (Capacitor) — added 2026-09-04

The Leaflet UI also ships as a native iOS app so the demo can be shown on a phone.
It is a **Capacitor 8 wrapper around the same `public/` directory** — no second
frontend, no React Native, no duplicated map code. `ios/` is committed; the build
artefacts inside it are not (`ios/.gitignore` covers `App/build`, `App/Pods`,
`App/App/public`, `App/App/capacitor.config.json`, `DerivedData`, `xcuserdata`).

```bash
npm run ios:sync    # vendor Leaflet into public/vendor, then `npx cap sync ios`
npm run ios:lan     # print the address to type into the app
npm run ios:icon -- app-logo.webp   # install the home-screen icon
npm run ios:open    # open ios/App in Xcode
```

Signing is already wired (`CODE_SIGN_STYLE = Automatic`, `DEVELOPMENT_TEAM =
QPW6FG23R7`, bundle id `in.gati.railtracker`, deployment target iOS 15).
Capacitor 8 uses **SPM**, not CocoaPods (`ios/App/CapApp-SPM/`), so a missing
`Pods/` directory is correct, not a defect.

### The DHCP lease already moved once — this is not hypothetical

Between 2026-09-04 and 2026-09-05 the Mac went **192.168.0.100 → 192.168.0.104**
with no action taken. The stale committed IP that white-screened the app was
`192.168.0.104`, so the address is now *coincidentally* right again — which is
exactly why a hardcoded IP is dangerous rather than merely wrong: it fails
intermittently. Always use the `.local` name `ios:lan` prints first.

### App icon

`app-logo.webp` (1254×1254, opaque) is the source; `scripts/set-app-icon.js`
installs it. Xcode 14+ asset catalogues take a **single 1024×1024** image and
derive the rest, so `AppIcon.appiconset/Contents.json` lists exactly one file and
this is a one-file swap, not the old 15-size grind.
- The script rejects non-square and sub-1024 sources, and **flattens alpha** — a
  transparent icon shows black through the iOS corner mask and fails App Store
  validation. Xcode reports these only as an opaque "unassigned children"
  warning, which is why the validation lives in the script.
- It **skips `sips` entirely** when the source is already a 1024×1024 opaque PNG
  and just copies it: a re-encode there is pure loss, and `sips` cannot write
  images under this repo's Bash sandbox (it stages scratch files in
  `/var/folders/…/T`, a denied-within-allowed path that no `allowWrite` lifts).
  So run `ios:icon` from a normal terminal.
- The icon shipped in `ios/` is **still the Capacitor template placeholder** until
  that command is run on a machine where `sips` can write.

### `server.url` is a trap — the default must stay bundled

Capacitor has two ways to load the web app, and the difference is not cosmetic:

- **Bundled (our default).** No `server.url`. The WebView loads `public/` from
  inside the app bundle, so the app **always boots**, and `public/app.js` can show
  its own "Connect to live tracker" setup screen to collect the Mac's address.
- **Dev server (opt-in only).** `server.url` set → Capacitor loads that URL and
  **ignores `webDir` entirely. There is no fallback.**

The app as originally built had `server.url: 'http://192.168.0.104:5050'` baked
into the committed config while the Mac was actually on `192.168.0.100`. That
white-screens the app **before any of our JavaScript runs**, so the in-app setup
screen — which was fully implemented and would have fixed it — could never
appear. A LAN IP in a committed config is a time bomb: DHCP renews the lease and
the app dies. `capacitor.config.ts` now takes the URL from
`GATI_DEV_SERVER_URL` at sync time instead:

```bash
GATI_DEV_SERVER_URL=http://MacBook-Air.local:5050 npm run ios:sync   # live reload
npm run ios:sync                                                     # bundled (default)
```

Verified both ways: the generated `ios/App/App/capacitor.config.json` gets
`{"cleartext":true}` by default and gains `"url"` only when the env var is set.

### How the app reaches the gateway

`public/app.js` keeps a `NATIVE_API_STORAGE_KEY` (`gati.native-api-base`) in
localStorage and routes **every** API call through `apiUrl(path)`. In a browser
`getApiBase()` returns `''` and paths stay relative, so the desktop demo is
untouched (verified: `isNativeApp() === false`, setup card hidden, nothing
written to localStorage). On device the base is prefixed.

- **Prefer the `.local` name over an IP.** `npm run ios:lan` prints
  `http://MacBook-Air.local:5050` **first** because mDNS survives a DHCP change;
  the raw `192.168.x.y` addresses follow. It reads the port from `.env` rather
  than hardcoding 5050.
- The setup form **probes `${base}/api/health` and requires `payload.success`**
  before persisting, so a wrong address is rejected at entry instead of producing
  a half-broken map.
- `normaliseApiBase()` had two real bugs, fixed 2026-09-04: it prepended
  `http://` to *any* non-http string, so `ftp://host:5050` became
  `http://ftp//host:5050` — which parses cleanly with hostname `ftp`, meaning the
  protocol check below it could never fire. And blank input returned `''` instead
  of throwing, leaving `apiUrl()` emitting relative paths against
  `capacitor://localhost`. Check the scheme **before** prepending.
- `localhost` on a phone is the phone. `src/server.js` binds all interfaces
  (`app.listen(port)` with no host) so the gateway is LAN-reachable, but
  `run_server.py` binds `127.0.0.1` by default — the model engine is deliberately
  Mac-only and the gateway proxies it server-side, which is why `curvatureEta`
  works on device. The consequence is that **`/dashboard` and `/admin` are not
  reachable from the phone**; set `GATI_MODEL_HOST=0.0.0.0` if you need them
  there, understanding that it exposes the model API to the whole network.
- CORS matters here: in bundled mode the page origin is `capacitor://localhost`,
  so every API call is cross-origin. `src/server.js`'s wildcard `app.use(cors())`
  is what permits it.

### ATS / cleartext

`Info.plist` carries `NSAllowsArbitraryLoads` **and**
`NSLocalNetworkUsageDescription` (mandatory since iOS 14 for LAN connections).
Both are needed for plain HTTP to a Mac on the same Wi-Fi. This is for on-device
testing only — use HTTPS before any distribution. `UIRequiredDeviceCapabilities`
was the Xcode template's stale `armv7`; corrected to `arm64`, since no 32-bit
device can run the iOS 15 deployment target.

`scripts/prepare-ios-web.js` vendors Leaflet into `public/vendor/leaflet` (the
bundle has no usable CDN fallback) and prunes `.DS_Store` from `public/` — `cap
sync` copies that directory verbatim, so a stray Finder file otherwise ships
inside the IPA. It fails loudly if `node_modules/leaflet` is absent rather than
producing a mapless bundle. Side benefit: the desktop UI now loads Leaflet from
`/vendor/leaflet/leaflet.js` locally instead of unpkg.

---

## 5e. Crossing / overtake conflict layer (Phase 5) — what is real, what is assumed

Predicts where our train will **meet** another on the single-line Konkan section,
who takes the **loop**, and how many minutes that costs — long before either train
is near the meet point, because it falls out of two timetables plus our live delay.
Tagline slot: this is the "**Prevent the ripple**" third of the tagline.

**Zero additional upstream requests.** Other trains' times are static schedules
read from `.cache/`; the only live input is our own `delayMinutes`, which the
gateway already fetches. Never poll other trains for this (VERIFIED #15).

### Pipeline
1. **`scripts/build_corridor.py`** (offline, no network) — normalises the 17 cached
   `.cache/train_*_live_fallback.json` runs into `.cache/corridor/{train}.json`:
   train meta plus stations as `code/name/km/arrMin/depMin/isHalt/lat/lng`, with
   times **day-normalised** (VERIFIED #16). `--dry-run` prints a per-train table and
   a missing-time audit. Skips `fleet_fallback.json` **by name** (VERIFIED #15).
2. **`conflict.py`** (cache-only, beside `eta_model.py`) — `find_conflicts(train,
   delay_min, offsets=(0,-1,-2))`. Joins on station code, classifies direction, then
   walks the shared stations detecting a **sign flip** in `gap = our_time −
   their_time`; linear interpolation between the bracketing stations gives the exact
   meet km, clock time and lat/lng. Same test serves head-on meets and
   same-direction overtakes — only the interpretation differs (VERIFIED #20).
   `--train`/`--delay` CLI prints every intermediate number.
3. **`eta_model.compute_eta(..., conflicts=True, conflict_delay_min=)`** — holds
   land on non-halt block stations while the ETA loop is over halt-to-halt blocks,
   so each hold is bucketed into the block whose `[d0, d1)` km range contains the
   meet. Adds `conflict_hold_min` per segment and to the totals ladder, plus a
   top-level `conflict_layer` block. **`conflicts=False` reproduces §4b exactly** —
   verified byte-identical on `running_min`, `historical_delay_min`, `dwell_min`.
4. **`GET /conflicts/{train}?delay=&offsets=`** on the model API; `/health` gained
   `corridor_trains` and `conflict_layer_available`.
5. **Gateway** (`train.controller.js`) — a **separate** call from `/eta`, on purpose:
   `/eta` needs route geometry, `/conflicts` needs only timetables, and 12051 is
   exactly the train where one works and the other 404s. Bundling them would let a
   missing polyline suppress a working conflict layer.
6. **UI** — `renderConflictPanel()` (three states: HELD red / RIGHT OF WAY green /
   none predicted dim, plus a distinct *unavailable* block) and `renderConflicts()`
   drawing meet markers in `conflictLayer`. The client does **no conflict
   arithmetic**, exactly as with the tunnel layer.

### Verification
`python3 verify_conflicts.py` — 10 property invariants over 8 trains × 6 delays
(**174 conflict rows**), plus determinism, type normalisation, ladder ordering,
delay monotonicity, reciprocity, C10 conditionality and honesty-flag presence.
**Reciprocity is the strongest evidence:** computed from 12052's own axis the meet
lands at km 102.7, which mirrors (582.3 − 102.7) to 479.6 — matching 12051's
independent view — and both agree 12052 is the one held.

**Proving a zero layer is actually wired** (per VERIFIED #9 — a zero-valued layer
hides its own bugs): 12051 and 22229 both *win* every crossing, so the ETA
contribution is legitimately **0.0**. Monkeypatching `normalise_type` to rank Vande
Bharat lowest produced 5 holds across 4 blocks, every meet km inside its block's
range, sums reconciling three ways, and ETA 615.7 → 697.7 (**+82.0**).

### Honesty requirements (do not remove from the UI)
- **Loop locations are assumed, not sourced.** Every timetable station on the
  single-line section is treated as able to hold a crossing. This source carries
  **no loop or track-count data** — `platform` is populated for the 11 booked halts
  only and is the platform-in-use, not a loop count. Recorded as
  `loopBasis: "assumed-all-stations"`, `loopDataIsOfficial: false`.
- **The priority ladder is our heuristic** over `train.type`, not official Indian
  Railways precedence (VERIFIED #18). `priorityIsOfficial: false`.
- **Other trains' times are scheduled**, only our delay is live.
  `otherTrainsAreScheduled: true`.
- **Overtakes show nothing in normal running** (VERIFIED #19) — describe as
  delay-conditional, never imply we routinely detect them.
- **`REACCEL_MIN = 3.0`** (loop entry/exit + restart from a dead stand) is a stated
  modelling constant, surfaced in the payload, not hidden in a formula.
- **Prediction only.** `decisionSupportOnly: true`. Every alert is for a human
  Section Controller to confirm; nothing is dispatched.
- A cached delay is labelled **`delayBasis: 'cached'`** and the panel says so
  (VERIFIED #21) — the crossings stay valid, the delay behind them may not.

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
- [x] **Phase 5 (done 2026-09-05):** Crossing / overtake conflict prediction with
      loop-hold minutes as an ETA layer. The old blocker — "needs a second train's
      live data" — was a **false premise** and is retracted (VERIFIED #15): meets
      fall out of two *timetables* plus our own live delay, so the layer runs
      entirely on `.cache/` at **zero additional upstream requests**.
      `scripts/build_corridor.py` → `conflict.py` → `eta_model` layer →
      `GET /conflicts/{train}` → gateway → Leaflet panel + meet markers. See §5e
      for what is real and what is assumed, and VERIFIED #15–#21 for the findings.
      - **Live end-to-end on 2026-09-05**, 12051 genuinely 51 min late: 6 meets
        predicted, all 6 won, each moved 12–24 km earlier than planned, plus one
        delay-created overtake of 12618.
      - What is **real**: the shared-corridor geometry, the meet km/clock/lat-lng,
        the delay shift, and our train's live delay.
      - What is **assumed**: loop *locations* (every timetable station on the
        single-line section — this source has no track-count data) and the
        precedence ladder (a heuristic over `train.type`, not IR rules).
      - Still open: real loop data (needs a user-supplied OSM extract), and
        freight/unscheduled traffic, which no public source exposes.
- [x] **Phase 6 (done 2026-09-01):** Tunnel identification + time-to-exit for
      GPS-blind zones. **69 real Konkan tunnels** (OSM way geometry, supplied as
      CSV → `build_tunnels.py` → `src/data/konkan-tunnels.json`), projected onto
      each train's chainage axis by `src/services/tunnels.js` and surfaced on the
      Leaflet map at `/` — every tunnel drawn as a segment of the route, the
      containing one highlighted, with a panel giving metres-in, metres-to-exit
      and **~minutes-to-exit**. Containment-based, not the old 15 km proximity
      match. See VERIFIED #11–#14 for the projection, axis and provenance
      findings, and §5c for what is and is not real here.
      - What is **real**: the 69 tunnels and their portal coordinates; the chord
        lengths (within 1.1% of published KRCL figures); the containment test.
      - What is **not live**: the speed. Time-to-exit uses the schedule-derived
        block speed (VERIFIED #3) and the UI says so on every figure.
      - Still open: the EMA speed recalibration path exists but has never run
        (`speed-history.json` ships empty), so no observed-transit data yet.
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
