# 🛠️ GATI — Technologies Used & Technical Approach

**GATI** — Dynamic ETA Forecasting & Conflict-Aware Recommendation System for
Indian Railways coaching trains. SIH 2026, PS 26028 (Ministry of Railways).
Team **Arka!**

> **Tagline:** Predict the delay. Explain the cause. Prevent the ripple.

---

## 0. Two things to read first

**0.1 — Safety framing (non-negotiable).**
GATI is a **decision-support / information system only**. No feature issues
automated commands to train control, signalling, or braking. Every conflict alert
and hazard escalation requires human confirmation by a Section Controller or
Control Room Operator. Nothing in this document describes, or builds toward,
automated train control.

**0.2 — This document distinguishes *built* from *planned*.**
Every capability below is tagged. We do not claim data sources or capabilities we
do not have, and we do not present planned architecture as shipped code.

| Tag | Meaning |
|---|---|
| ✅ **BUILT** | Implemented, running, and verified with printed intermediate numbers |
| 🟡 **PARTIAL** | Implemented but degraded, unvalidated, or never exercised on real data |
| ⬜ **PLANNED** | Design/pitch target. Not in the codebase. |

---

## 1. System Architecture

```
 ┌──────────────────────────────────────────────────────────────┐
 │  Frontend — Leaflet live map (:5050/) + static dashboards    │
 │  • fleet markers, route polyline, telemetry drawer           │
 │  • 69-tunnel overlay, containment highlight, time-to-exit    │
 │  • ETA layer ladder, delay bars, curvature panel             │
 │  • also ships as a native iOS app (Capacitor wrapper around  │
 │    this same directory — no second frontend)                 │
 └───────────────┬──────────────────────────────▲───────────────┘
                 │ HTTP / REST (+ WS on :8000)  │
                 ▼                              │
 ┌──────────────────────────────────────────────┴───────────────┐
 │  Gateway — Node 18 + Express (:5050)                         │
 │  • upstream rate governor (≤9 starts / trailing 60 s)        │
 │  • equal-jitter backoff, global 429 cooldown                 │
 │  • monthly per-key quota guard, rotation as last resort      │
 │  • node-cache tiers; .cache/ disk fallback on upstream fail  │
 │  • tunnel chainage projection + dead reckoning               │
 └───────┬──────────────────────────────────────┬───────────────┘
         │                                      │
         ▼                                      ▼
 ┌────────────────────┐            ┌──────────────────────────────┐
 │ RailRadar API v1   │            │ ETA engine — Python FastAPI  │
 │ (prototype source, │            │ (:8000) — cache-only, no     │
 │ crowdsourced GPS)  │            │ upstream calls of its own    │
 └────────────────────┘            │ • curvature / weather cap    │
                                   │ • schedule baseline speeds   │
                                   │ • historical delay increments│
                                   │ • halt dwell                 │
                                   └──────────────┬───────────────┘
                                                  ▼
                                   ┌──────────────────────────────┐
                                   │ Local data                   │
                                   │ • .cache/ RailRadar payloads │
                                   │ • konkan-tunnels.json (OSM)  │
                                   └──────────────────────────────┘
```

**Why two runtimes.** The Python side owns the numerical model and is
**cache-only** — it never calls RailRadar, so the model can be re-run and audited
without spending quota. The Node side owns everything that touches the network
and the map. The Node gateway calls `http://127.0.0.1:8000/eta/{train}` and
attaches the result as `curvatureEta`, so the live map and the analytical
dashboard render the *same* model rather than two drifting copies.

---

## 2. Data Sources & Provenance

This is the table to read carefully. Data provenance is where railway
prototypes usually overclaim.

| Source | What we get | Status | Honest framing |
|---|---|---|---|
| **RailRadar API v1** (`api.railradar.in/v1`) | Live running status, position, timetable, halts, coach layout, route GeoJSON | ✅ BUILT | **Prototype data source. Crowdsourced-GPS-based** — same category as RailYatri/ixigo. **NOT** official Indian Railways telemetry and **not** equivalent to RTIS. Free tier: 1,000 req/month/key. |
| **RTIS** (ISRO/CRIS GPS on locomotives), via CRIS **Project Pravah** | Authoritative locomotive GPS | ⬜ PLANNED | Requires official Railways authorization we do not have. This is the **production vision**, stated as such. |
| **OpenStreetMap way geometry** (69 Konkan tunnels) | Tunnel portal coordinates | ✅ BUILT | Supplied as CSV, parsed **offline** by `build_tunnels.py`. **No Overpass API call is made.** `_meta.sourceIsOfficial` is `false`. Validated against published KRCL lengths to ≤1.09%, but it is **not** official KRCL alignment data. |
| **OpenWeatherMap / IMD** | Live weather per segment | ⬜ PLANNED | **Not wired in.** The model currently applies *static placeholder* multipliers (§4.3). Say "weather-capping is implemented, the live feed is the next integration" — never "we use live weather". |
| **Crowdsourced hazard reports** | Passenger hazard reports + geofenced location | ⬜ PLANNED | Phase 7. Genuinely our own new data when built. |
| **Basemap tiles** — Esri World Imagery, Esri Boundaries & Places, CARTO Dark Matter, OpenRailwayMap | Map raster | ✅ BUILT | Displayed interactively, per each provider's terms. Bulk caching to disk from these three is **refused** by `fetch_tiles.py` because it breaches their terms. |

### 2.1 The most important data finding: `speedToNextStationKmph` is not live

The field name implies a live speed signal. It is **100% schedule-derived** —
confirmed byte-identical across 4+ different run dates for 81 of 82 stations. It
is computed per halt-to-halt block and applied uniformly to intermediate non-halt
stations within that block.

**Consequence:** *no live speed exists anywhere in this data source.* Every
speed-derived number in GATI (including tunnel time-to-exit) is labelled
schedule-derived, and the basis label travels with the number into the UI so a
figure can never be rendered without it. This was caught by checking raw numbers
across dates instead of trusting a plausible field name — the discipline that
shapes the rest of the project.

---

## 3. Technology Stack

### 3.1 Python — model & analytical API

| Category | Technology | Role |
|---|---|---|
| Language | **Python 3.10+** | Numerical model, geometry, verification reports |
| API framework | **FastAPI** | `/eta/{train}`, `/eta/{train}/curvature`, `/geometry/{train}`, `/health`, `/dashboard`, `/admin` |
| Push channel | **FastAPI WebSocket** — `/ws/eta/{train}` | Push-based ETA updates (the pitched stack is push, not polling). Shares one payload builder with `GET /eta` so the two can't diverge. |
| ASGI server | **Uvicorn** (`h11`) | Served via `run_server.py`, a hardened launcher that pre-imports `h11`/`LifespanOn` so lazy imports can't fail under a restricted sandbox |
| Libraries | **stdlib only** for the model — `math`, `json`, `datetime`, `glob`, `re`, `os` | `requests` is used **only** by the fetch scripts, never by the model. No NumPy/SciPy/pandas: the model is pure-stdlib and therefore trivially auditable. |

### 3.2 Node — gateway & live map server

| Technology | Version | Role |
|---|---|---|
| **Node.js** | v18+ (ES Modules) | Runtime |
| **Express** | ^4.21.2 | Routing, controllers, centralized error handling |
| **Axios** | ^1.7.9 | Upstream HTTP client. Deliberately module-private — never exposed as `this.client`, so no method can bypass the rate governor. |
| **node-cache** | ^5.1.2 | TTL cache. **Live tier = 0 s** (`CACHE_TTL_LIVE=0`, never cached); **static tier = 86400 s**. The asymmetry is deliberate (`src/config/env.js:143`). |
| **express-rate-limit** | ^7.5.0 | *Inbound* client rate limiting (distinct from the outbound governor) |
| **morgan** | ^1.10.0 | Request logging |
| **cors** | ^2.8.5 | Cross-origin access |
| **dotenv** | ^16.4.7 | Config/secret loading |

### 3.3 Frontend — zero-build client

| Technology | Role |
|---|---|
| **Vanilla ES6+ JavaScript** | No framework, no bundler, no build step. Direct DOM updates. |
| **HTML5 / CSS3** | Glassmorphic dark theme (`#080b11`, `#0f172a`), flexbox + grid, cubic-bezier transitions |
| **Leaflet 1.9.4** | Interactive map — polylines, markers, layer groups. Loaded **local-first** from `/vendor/leaflet/`, with the unpkg CDN injected dynamically (SRI preserved) only if that 404s. Not via `document.write`, which Chrome may block on exactly the slow connections this fallback exists for. |
| **Inline SVG** | `dashboard.html` route rendering (see §6.2) and UI gauges |
| **`offline-tiles.js`** | An `L.TileLayer` **subclass** overriding `createTile`: it requests `/tiles/<layer>/{z}/{x}/{y}.png` first and falls back to the CDN **per tile**. Gated by a `/tiles/pack.json` manifest read once at startup. **No IndexedDB and no ServiceWorker are involved.** |
| **Capacitor 8 (iOS)** | Native iOS wrapper around this same `public/` directory — one frontend, not two. Swift Package Manager (no CocoaPods). Web assets load from the app bundle by default, so the app always boots; the Mac gateway's LAN address is entered on-device and health-checked before being saved, rather than compiled in. See CLAUDE.md §5d. |

---

## 4. Technical Approach — the ETA model

The core claim GATI makes is that ETA should be **composed from physically and
operationally meaningful layers**, each independently auditable, rather than
emitted by one opaque estimator. `eta_model.compute_eta()` computes, per
halt-to-halt segment:

```
eta_segment =  distance / min(baseline_speed, curve_cap, weather_cap)
             + historical_delay_increment
             + dwell_at_arriving_halt
```

Dwell is counted at the **arriving** halt so the origin is excluded and no halt
is double-counted.

### 4.1 Layer A — schedule-derived baseline speed ✅ BUILT
Per-block speed from the timetable (§2.1). This is the workhorse: it contributes
**+177 min** of the model's correction over naive flat-speed.

### 4.2 Layer B — curvature speed capping ✅ BUILT *(headline USP)*

Every track segment gets its own physically achievable speed, capped by curve
radius, instead of one average speed for the whole journey.

- **Radius from 3-point circumcircle** (Menger curvature): for consecutive
  polyline vertices, `R = abc / 4A` where `a,b,c` are side lengths and `A` the
  triangle area. Collinear points → `R = ∞` → no cap.
- **Distance**: Haversine great-circle.
- **Permissible speed**: `V (km/h) = 4.58 · √R` with `R` in metres —
  `curvature.CURVE_SPEED_CONSTANT`, an **RDSO broad-gauge approximation** for
  normal cant. It is an empirical coefficient that folds cant and cant deficiency
  into one constant; it is *not* derived here from a stated lateral-acceleration
  budget. (For reference, `4.58` implies ≈1.62 m/s² lateral acceleration — quoted
  as an implication of the constant, not as an independently sourced parameter.)
- **Applied per-vertex, then integrated** — never per-block.

**Per-vertex integration is the methodological core.** Applying a block's
*sharpest* radius to the whole block overstates the penalty by **~2,200×**: the
R=268 m curve near Panvel covers ~80 m of actual track, but smeared across all
175 km of PNVL→KHED it invents +3.0 min when the true integrated cost is
**0.081 seconds**. `mode=vertex` is the default; `mode=block` exists only as an
explicitly-labelled conservative upper bound (correct when a source exposes one
radius per block). **The block number is never presented as measured physics.**

**And we state the honest result.** On this route curvature is
**essentially non-binding: +0.0013 min (0.08 s) over 588 km**, binding on exactly
one 80 m sub-segment. The reason is structural, not a bug — the timetable's own
baseline speeds (28–77 km/h) already sit *below* the RDSO curve caps almost
everywhere, so `min(baseline, curve_cap)` picks the baseline.

Where the layer earns its place is **validating a proposed faster schedule**:
at a uniform target speed, curvature costs 80 km/h → +0.0 min; 100 → +0.2;
110 → +0.4; 130 → +1.1; **160 → +3.1 min**. The honest framing is *"this
alignment could not support a 160 km/h path without ~3 min of curve loss"* —
not *"curvature explains today's 635 min"*. Curvature will matter far more on
Shimla-Kalka or Araku Valley; we say so rather than overselling Konkan.

**Known resolution limit, stated on every curvature figure.** Vertex spacing is
median 195 m but includes 147 spans over 1 km (max 11.9 km), covering 327 of
581 km. A 3-point circumradius cannot resolve a curve shorter than its own
chord, so across **56% of the route curvature is undetectable, not absent.**
Every curvature result is reported as *"in the resolvable ~44% of the route"*,
and `geometry_resolution()` returns the blind fraction through both API endpoints.

### 4.3 Layer C — weather speed capping 🟡 PARTIAL
Multiplier applied to the curve cap from `curvature.WEATHER_SPEED_FACTOR`:
clear 1.0, rain 0.85, heavy_rain 0.65, monsoon_flagged_section 0.6, fog 0.5.
**These are untuned placeholders, not sourced from TSR data** — illustrative
sensitivity only. The mechanism is real and wired end-to-end; the coefficients
and the live feed are not. The dashboard raises a placeholder warning whenever
`weather != clear`, and the `curve +` column renames itself to `curve+wx +`
because the penalty field has the weather factor folded in and is no longer
curvature-only.

### 4.4 Layer D — historical delay ✅ BUILT
Mean per-segment delay increment from cached completed runs.

**Two findings make this layer correct:**

1. **`delayArrival` is CUMULATIVE — never sum it.** It equals
   `actualArrival − scheduledArrival`, so it already contains every minute lost
   earlier in the run. Summing the 8 cumulative values for one date gave
   **+149 min for a run that finished 3 min EARLY**. Fix: difference along the
   halt chain per date, then average — `increment(b) = cum(b) − cum(a)`.
   Increments telescope back to the end-to-end delay, the only delay figure that
   may be added to a schedule-derived running time.
   *This bug was invisible while every value was 0 and produced a ~64 min error
   the instant real actuals arrived — a zero-valued layer hides its own bugs.*
2. **Zero-echo dates must be skipped, not averaged in as zeros.** A
   completed-but-untracked run reports `delayMinutes: 0`; treating that as "ran
   on time" drags the mean toward nothing. Of 9 cached dates only **5** carry a
   real signal (`trackingMode: "real-time"` with non-null `delayArrival`). The
   audit counts non-null `delayArrival` **and** `actualArrival != scheduledArrival`
   per date *before* averaging. It is **per-date, not per-tier** — always audit.

**And the counter-intuitive result we report rather than hide:** train 22229 runs
**EARLY on average, −19.6 min** (−43, −3, −33, −20, +1). The delay layer
*subtracts* time. An Indian Railways delay model that can only add would be wrong
here.

### 4.5 Layer E — halt dwell ✅ BUILT
Scheduled dwell at each arriving halt; **+17 min** total for 22229.

---

## 5. Verified Results — train 22229 (CSMT–Madgaon Vande Bharat)

Scheduled 635 min / 588 km. Max **operating** speed per API is 80 km/h (not the
130 km/h rating) — we use 80.

| Model | ETA (min) | vs 635 sched | vs 615.4 observed |
|---|---|---|---|
| Naive flat 80 km/h | 441.0 | −194.0 | −174.4 |
| + schedule baseline speeds | 617.9 | −17.1 | +2.5 |
| + curvature (`mode=vertex`, default) | 617.9 | −17.1 | +2.5 |
| + halt dwell | 634.9 | −0.1 | +19.5 |
| **+ historical delay → FINAL** | **612.8** | **−22.2** | **−2.6** |
| (same, `mode=block` upper bound) | 615.7 | −19.3 | +0.3 |

**Layer contributions:** baseline speeds **+177 min**, dwell **+17 min**,
historical delay **−22.1 min**, curvature **+0.0013 min**.

### 5.1 How to read that table honestly

**Two comparisons, kept separate:**

- **vs timetable (635 min) → 634.9 min.** This is **near-circular** and is *not*
  an accuracy claim: the baseline speeds *are* the timetable, so reproducing it is
  arithmetic. We use it only as a wiring check that each layer is connected. The
  −0.1 min residual sits at the rounding floor of the timetable's own
  integer-minute arrivals — computing an "N× better than naive" ratio off it
  would produce a meaningless four-figure number.
- **vs observed runs (615.4 min mean over 5 tracked dates) → 612.8 min, error
  −2.6 min**, against naive flat-80's −174 min. **This is the real validation.**

**Always quote the band, not just the mean.** Observed journeys were
592 / 632 / 602 / 615 / 636 min — a **44 min spread**. One accuracy number off a
5-sample mean with a 44 min spread would oversell the model.

**We do not claim accuracy comes from the physics layer.** Of the 194 min the
naive model misses, +177 comes from schedule baseline speeds and +17 from dwell.
Curvature contributes +0.0013 min and is not doing the work.

---

## 6. Geometry Engineering

Two axis problems dominate this project. Both were found by measuring rather than
assuming, and both have the same shape: *a quantity defined on one axis compared
against a quantity defined on another.*

### 6.1 Halt-anchored per-block renormalisation ✅ BUILT
The polyline measures 581.4 km; the timetable says 588 km. A single global scale
factor smeared that 6.6 km mismatch across all blocks as ±0.5 min of noise —
enough that the vertex row once sat *below* baseline-only, implying curvature made
the train **faster**. Fix: snap each halt to its nearest vertex by its own
lat/lng (`snap_halts_to_vertices`, indices forced monotonic rather than trusted),
then renormalise each block's sub-segment lengths to that block's timetable
distance. This makes the invariant exact: **vertex running time can never be less
than baseline-only**, so any difference it reports is curvature and nothing else.
Verified: penalty ≥ 0 on all 8 blocks; block distances sum to exactly 588 km.

### 6.2 Why `dashboard.html` draws inline SVG, not a tiled map
The analytical dashboard has no network egress in its environment, so a tiled
basemap would render blank. The route is inline SVG from the real 1184-vertex
polyline, north-up, with the viewBox sized from the data aspect — a fixed wide box
flattens a 3.9°-latitude corridor into a smear. Halt labels alternate sides and
are decluttered per side by sorting on y, because CSMT→DR→TNA→PNVL doubles back:
**latitude is not monotonic along the journey**, and four labels land in a ~32 px
band.

---

## 7. Tunnel Intelligence Engine ✅ BUILT *(USP #2)*

**The one physical-geometry feature on this route with an effect big enough to
matter.** 69 tunnels, **65.6 km of bore over 582 km = 11.3% of the route
underground**, median 593 m, longest **Karbude at 6535 m** (India's longest rail
tunnel). Karbude's transit at its schedule-derived block speed of 55.8 km/h is
**~7.1 min**. Contrast curvature's +0.0013 min.

### 7.1 Pipeline

| Stage | Component | What it does |
|---|---|---|
| Build | `build_tunnels.py` | Parses a CSV of OSM way geometry **offline — no network, no Overpass call** → `src/data/konkan-tunnels.json`. `--dry-run` re-audits without writing. |
| Project | `src/services/tunnels.js` | Projects all 69 tunnels onto *that train's* chainage axis; answers containment |
| Serve | `src/services/deadReckoning.js` | Attaches `liveData.tunnels` (always) and `liveData.deadReckoning` (only when GPS is stale >3 min) |
| Render | `public/app.js` | 69 tunnels as segments *of* the route line; containing one highlighted; three-state panel |

### 7.2 Finding: portals must be projected perpendicularly, never snapped to a vertex

Because vertex spacing runs to 11.9 km, nearest-vertex snapping puts **both
portals of a short tunnel on the same vertex** — the tunnel gets zero chainage
length and containment can never fire.

| Method | Portal offset | Degenerate (zero-length) |
|---|---|---|
| Nearest-vertex snapping | median 155 m / max 2517 m | **18 of 69** |
| Clamped-`t` perpendicular projection | **median 1 m / max 10 m** | **0 of 69** |

On the live 12051 projection the offsets are 0.2–0.5 m. This also **retracted two
premises from our own plan**: the "median 56 m snap error" was vertex
quantisation, not OSM-vs-RailRadar disagreement (the portals sit essentially *on*
RailRadar's alignment); and "along-track length is worse, Tike +31%" was an
artifact of the same method — with projection Tike's along-track/chord ratio is
1.00, so the two length bases **corroborate** each other.

### 7.3 Finding: the train's position and the tunnel's chainage live on different axes

`currentLocation` has **no lat/lng** — the train's position is
`distanceFromOriginKm` on the **timetable** axis, while tunnel chainage is on the
**polyline** axis. They differ by 551 m on 12051 and **6604 m on 22229**. The
median tunnel is 593 m, so comparing the axes directly misplaces the train by
more than a whole typical tunnel.

`tunnels.js` renormalises per block using route stations as anchors — the same
correction §6.1 applies to halts, for the same reason. **Measured worth:** on
22229 (81 anchors) anchored vs global-scale chainage differ by median 655 m /
max 1576 m, and **41 of 69 tunnels shift by more than their own length**. Without
it most tunnels would be misidentified.

**It degrades loudly, never silently.** `projectTunnelsOntoRoute` reports
`axisBasis: 'station-anchored' | 'global-scale' | 'unavailable'` and the UI
renders a warning for anything but the first. Anchoring needs
`includeCoordinates: true` on the live call — a free parameter on a request we
already make. Two separate call sites had to send it; fixing only the service
left the drawer broken (verified before/after: `stationsWithLatLng` 0 → 87,
`axisBasis` `global-scale` → `station-anchored`).

### 7.4 Two lengths that must never be mixed
`chordLengthM` is the portal-to-portal great circle — the published number,
matching KRCL figures to ≤1.09% (Karbude 6535 vs 6506, Natuwadi 4409 vs 4387,
Tike 4087 vs 4077, Savarde 3410 vs 3447). `chainageLengthM` is the tunnel's span
on that train's timetable axis, and it is what `metresIn`/`metresToExit` measure
against. They differ 0.5% on 12051 but **3.7% on 22229**, where Karbude reads
6535 m chord / 6778 m chainage. The panel shows the axis length beside the chord
whenever they differ by >2% — otherwise "6.53 km" followed by "6777 m to exit"
reads as an arithmetic error.

### 7.5 Honesty wiring in the UI
- **Containment-based, not proximity-based.** A 15 km nearest-match is meaningless
  when 69 tunnels have a median length of 593 m.
- **Colour tracks the SIGNAL, not the tunnel.** Amber = tunnel ahead, cyan = inside,
  red = *signal lost*. A train can sit inside a short bore with a perfectly fresh
  fix; red is reserved for the condition an operator must act on.
- **Time-to-exit is schedule-derived** (§2.1) and the basis label travels with the
  number, so the minutes can never render alone.
- **The client does no chainage arithmetic of its own** — every number comes from
  `tunnels.js`, so the two cannot drift.

### 7.6 Source defects recorded, not silently patched
All in `_meta`: **duplicate `#66`** (Pernam and Sherpe share it); **numbers 67, 68,
69 are absent** — one of the `#66` pair most likely belongs in that gap, but which
is not inferable from the CSV, so both rows are kept and **neither is renumbered**;
**`36A` is a legitimate tunnel number**, so `Tunnel No` is a **string** (`int()` on
it raises — this actually happened); **CSV row order is not chainage order**.
We do not invent the missing three.

### 7.7 Dead reckoning 🟡 PARTIAL
`enhanceLiveData()` estimates position from last-known speed and tunnel length
when GPS goes stale >3 min. Every invented number that used to live here is
**gone** — `signalDropProbability`, the `|| 40` and `|| 50` speed defaults, the
`remainingKm = 20` fallback, and the zone-match confidence boost. The path now
returns `null` / `unavailableReason` rather than fabricating a value.
`src/data/tunnel-zones.json` (25 hand-written zones with coordinates wrong by up
to ~93 km) was **deleted**, not merely unwired — it named the wrong tunnel.

**EMA speed recalibration is implemented but has never run.** `speed-history.json`
ships with `zones: {}` and `lastUpdated: null`, so there is no observed-transit
data yet. It is listed as PARTIAL for that reason.

---

## 8. Upstream Quota Engineering ✅ BUILT

The free tier is 1,000 req/month/key, but the binding constraint turned out to be
a **per-minute burst quota**. Naive fan-out over a 20-train fleet produced a
429-storm on all keys on every refresh.

| Mechanism | Detail |
|---|---|
| **Rate governor** | One **global** serialized queue — not per-method. Holds starts to `perMinute` (default **9**) in any trailing 60 s. The fleet poll, drawer poll and route fetches all spend from one allowance; throttling them separately re-created the overrun from three directions. |
| **Equal-jitter backoff** | `delay = target/2 + rand(target/2)`, capped. Unjittered delays re-synchronise concurrent backoffs into a fresh burst. |
| **Global 429 cooldown** | A 429 is a property of the *upstream*, not of the one request that tripped it — so the cooldown is shared, or sibling requests reproduce the storm during the first one's backoff. |
| **Monthly per-key quota guard** | `RAILRADAR_MONTHLY_QUOTA_PER_KEY` (default 1000) with per-key counters; exhausted keys are skipped. |
| **Key rotation as LAST resort** | **Not** load balancing. Because the limit is per unit time, rotating on 429 spreads one overrun across five keys and burns five monthly budgets instead of waiting a few seconds. Rotation happens only *after* backoff on the current key is exhausted. |
| **Private axios instance** | Module-private, never exposed as `this.client`, so no future method can issue an unthrottled call and quietly reintroduce burst 429s. |
| **Disk fallback** | On upstream 429/failure the controller falls back to `.cache/` (in-memory, then disk) so a demo survives a quota wall or an offline network. |
| **Client polling** | The map polls the **server** (fleet 60 s, selected train 20 s) and does **not** send `?refresh=true`. |

---

## 9. Offline Map Pack 🟡 PARTIAL — *pipeline ships, tile bytes do not*

`fetch_tiles.py` builds a local raster pack into `public/tiles/`; cache-first and
resumable, `--dry-run` estimates size with **no** network access. It writes a
`pack.json` manifest recording the preset *name* — never the URL template, which
would carry the API key (`/tiles/pack.json` is publicly served).

**Manifest-gating measured:** before it, every tile ate a guaranteed 404 first
(~350 console errors per load). After, a pack-less load makes **1** local request
instead of ~350, and `maxNativeZoom` comes from the manifest, so there is no
constant to hand-edit.

**Terms compliance:** `fetch_tiles.py` **refuses** to bulk-download from Esri,
CARTO and OpenRailwayMap — displaying those tiles interactively is fine, bundling
them to disk breaks their terms. Use MapTiler / Stadia / Thunderforest presets or
`--url-template`. The `osm` preset is gated to ≤5,000 tiles at concurrency 1 per
the OSMF Tile Usage Policy.

**Current state:** nothing in `public/tiles/` or `public/vendor/` is committed
(both gitignored). Until the README's two commands are run on a networked machine,
**the map has no local tiles and the CDN serves it exactly as before.** Verified
end-to-end with a synthetic 172-tile pack: manifest detected, `maxNativeZoom`
auto-set to 8, basemap painted from disk, an unpacked layer went straight to Esri
with zero local requests, and z11 clamped to z8 and upscaled rather than going
blank. Say *"the map degrades gracefully and can be packed offline"* — never
*"the map works offline"*.

---

## 10. Verification Methodology

The working rule: **print intermediate numbers, don't just report final results.**
Every layer must be independently checkable before the combined total is trusted.
This project has already caught a false lead (`speedToNextStationKmph`), a
cumulative-vs-incremental bug that only surfaced when real data arrived, a
2,200× curvature overstatement, and two wrong premises in its own approved plan.

| Tool | What it verifies |
|---|---|
| `report_eta.py` | 9-step layer-by-layer report: baseline vs hand-calculated speed, per-block radii, the delay audit, dwell, block-vs-vertex, before/after table, ghat isolation, weather sensitivity |
| `api.py` `/health` | Per-date real-signal vs zero-echo audit |
| `/admin` | Model audit console — every ETA layer opened up |
| `build_tunnels.py --dry-run` | Re-audits the tunnel dataset offline: parsed rows, length distribution, KRCL validation deltas, projection offsets, every defect |
| `fetch_dates.py` | Cache-first historical fetcher; re-audits every cached run for a real delay signal; degrades gracefully with no network |
| `verify_integration.py` | End-to-end Node gateway ↔ Python engine |
| `verify_speed_field.py` | The cross-date audit that proved `speedToNextStationKmph` is static |
| `fastapi.testclient` | All routes end-to-end including 422/404 paths |

**Invariant assertions** (not just spot checks): curvature penalty ≥ 0 on all 8
blocks; block distances sum to exactly 588 km; every tunnel `exitKm > entryKm`;
all 69 inside `[0, 588]`; zero degenerate lengths.

---

## 11. Build Status

| Phase | Status | Notes |
|---|---|---|
| 0 — API access | ✅ BUILT | Key working, real data confirmed |
| 1 — `railradar_client.py` | ✅ BUILT | Live status + route geometry |
| 2 — `curvature.py` | ✅ BUILT | Verified against known geometry and real route data |
| 3 — Combined ETA model | ✅ BUILT | `eta_model.py`, verified by `report_eta.py` |
| 4 — FastAPI wrapper | ✅ BUILT | `/eta`, `/health`, `/curvature`, WebSocket push |
| **5 — Block conflict prediction** | ⬜ **PLANNED** | USP #3. Needs a second train's live data on a shared/crossing section. **Never rendered as if it works.** |
| 6 — Tunnel identification | ✅ BUILT | §7. 69 real tunnels, containment, time-to-exit |
| **7 — Crowdsourced hazards** | ⬜ **PLANNED** | USP #5. Independent of live data; buildable in parallel. |
| 8 — Dashboard UI | ✅ BUILT | `dashboard.html` + Leaflet live map |

**USPs 3 (conflict-point prediction), 4 (delay cascade) and 5 (hazard reporting)
are pitch targets, not shipped code.** The dashboard's Build Status panel shows
them as `NEXT`/`TODO` and never renders conflict alerts or hazard pins.

---

## 12. Known Limitations — stated, not buried

1. **Data source is crowdsourced GPS, not RTIS.** Prototype-grade. RTIS-ready via
   Project Pravah in production.
2. **No live speed exists in the source.** Every speed-derived figure is
   schedule-derived and labelled as such.
3. **Weather coefficients are untuned placeholders** and the live feed is not
   wired in.
4. **Curvature is non-binding on this route** (+0.0013 min) and undetectable
   across 56% of the polyline. Its value is validating *proposed faster*
   schedules, and on mountain routes rather than Konkan.
5. **Validation rests on 5 tracked dates with a 44 min spread.** A mean of 615.4
   min hides real variance; we quote the band.
6. **The tunnel dataset is OSM-derived with recorded defects** (duplicate #66,
   missing 67–69) and is not official KRCL alignment data.
7. **EMA speed recalibration has never run** — no observed-transit data yet.
8. **The offline tile pack pipeline ships without tile bytes.**
9. **Conflict prediction and hazard reporting are not built.**
10. **Delay cascade modelling (USP #4) is not implemented.** No exponential
    cascade or propagation model exists in the codebase today.

---

## 13. Production Vision (⬜ PLANNED — pitched stack, not current code)

Stated separately from §3 so the two are never confused.

- **Data:** RTIS/CRIS Project Pravah; OpenWeatherMap/IMD live; public historical
  datasets for buffer training
- **ML:** XGBoost/LightGBM baseline, LSTM for sequence, graph model for cascading
  delay and conflict
- **Backend:** Python FastAPI, REST + WebSocket, PostgreSQL + TimescaleDB, Redis
  (cache + pub/sub)
- **Frontend:** React/Next.js, Mapbox GL / Deck.gl, WebSocket client
- **Infra:** Docker

Today's implementation deliberately uses **stdlib Python and vanilla JS with no
build step** — the model stays auditable line-by-line, which is what let every
finding in this document be caught by reading numbers.

---

## 14. Reference

- **Demo train:** 22229/22230 CSMT–Madgaon Vande Bharat, Konkan Railway.
  580.6 km (API) / 588 km (official); 635 min scheduled; max **operating** speed
  80 km/h.
- **Secondary live train:** 12051.
- **Repository:** `fernandesallan745-eng/RAIL`
- **Package management:** `npm` (Node), `pip` (Python)
- **Standards:** GeoJSON (RFC 7946) for track geometry — coordinate order
  `[lng, lat]`; Indian Railways station alpha codes (`CSMT`, `MAO`, `RN`).
  Note the RailRadar nesting quirk: coordinates live at
  `data.geojson.geometry.coordinates`, with an extra `geojson` wrapper.

---

*Every number in this document is reproducible from the verification tools in
§10. Where a capability is planned rather than built, it is tagged ⬜ PLANNED.*
