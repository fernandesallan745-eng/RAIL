# 🚄 GATI — Dynamic ETA Forecasting for Indian Railways

**GATI** is a dynamic ETA forecasting and conflict-aware recommendation system for
Indian Railways coaching trains (SIH 2026, PS 26028). It pairs a Python physics/ETA
engine with a Node & Express gateway and a Leaflet live map, over the
[RailRadar API](https://railradar.in/docs) as its prototype data source.

> **Decision-support only.** Nothing here issues commands to train control,
> signalling or braking. Every alert is human-confirmed. See
> [TECHNOLOGIES.md](TECHNOLOGIES.md) for the full technical approach and the
> data-provenance table.

## 🌟 Key Features

- **Secure API Key Management**: Loads your `RAILRADAR_API_KEY` from `.env` and automatically handles `Bearer` token authorization headers for every upstream request.
- **Smart Response Caching**: In-memory TTL caching with `node-cache`. Static schedules/routes are cached 24 h; **live running status is not cached by default** (`CACHE_TTL_LIVE=0`) so the map always shows fresh positions — the upstream burst quota is protected by the rate governor instead.
- **Rate Limiting & Protection**: Built-in `express-rate-limit` on the inbound side, plus an **upstream rate governor** — a single serialized queue holding all outbound calls to ≤9 starts per trailing 60 s, with equal-jitter exponential backoff and a global 429 cooldown shared across the fleet poll, the drawer poll and route fetches.
- **Error Resilience**: Intercepts upstream RailRadar errors (401, 404, 429, 504 timeouts) and formats them into clean, structured JSON responses. On upstream failure the live endpoint falls back to `.cache/` so a demo survives a quota wall.
- **Live Map UI**: A dark-mode Leaflet map at `http://localhost:5050` — fleet positions, route polyline, per-train telemetry drawer, tunnel overlay, and the ETA-model breakdown fetched from the Python engine.
- **Generic Proxy Support**: Transparently proxies any custom RailRadar subpath via `/api/proxy/*`.
- **Tunnel Tracking (GPS blind spots)**: All 69 Mumbai–Goa Konkan tunnels are drawn on the live map, and the API reports which tunnel a train is inside, how many metres to the exit, and roughly how many minutes — so a signal drop is explained rather than just displayed. Geometry is OpenStreetMap-derived (chord lengths within 1.1% of published KRCL figures), **not** official alignment data; time-to-exit uses the schedule-derived block speed, since this data source carries no live speed.
- **Crossing & Overtake Prediction (single line)**: Predicts *where* the selected train will meet an opposing train on the single-line Konkan section, *who takes the loop*, and *how many minutes* that costs — hours before either train is near the meet point. Meet points are drawn on the route and both outcomes are always shown (held **and** right-of-way). Costs **zero extra upstream requests**: the other trains' times come from cached static timetables, and only our own delay is live. Loop locations are **assumed** and the precedence ladder is **our heuristic**, not official IR rules — see "Crossing prediction" below.

---

## 🚀 Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Your API Key
Open `.env` and add your RailRadar API key:
```env
PORT=5050
RAILRADAR_API_KEY=your_railradar_api_key_here
RAILRADAR_BASE_URL=https://api.railradar.in/v1
```

> **Why 5050 and not 5000?** On macOS, port 5000 is held by ControlCenter
> (AirPlay Receiver), which answers with HTTP 403 — the browser renders that as
> *"Access to localhost was denied"* and it looks like a server bug. Disable
> *AirPlay Receiver* in System Settings → General → AirDrop & Handoff if you
> want 5000 back.

### 3. Start the Server

Start both the Python ETA engine and the Node gateway together:

```bash
npm run dev
```

`npm start` runs the same pair without Node's watch mode. The launcher stops both
processes when you press `Ctrl+C`. To run them separately for troubleshooting,
use `python3 run_server.py` for the model on `:8000` and `npm run server`
for the gateway on `:5050`.

Visit **`http://localhost:5050`** for the live map, and **`http://localhost:5050/admin`**
for the operator console — the same map with admin panels on top (every map and model
layer, upstream quota, model query controls). Both are served by the Node gateway, so
both work from the phone. The Node layer calls `http://127.0.0.1:8000/eta/{train}` and
attaches the result as `curvatureEta` on the live payload — so the map and the console
show the *same* model.

`server.js` auto-increments the port if the configured one is busy, so **read the
startup banner** for the actual URL rather than assuming 5050.

### Test on iPhone

The repository includes a native iOS wrapper in `ios/`, built with Capacitor — it
loads the same `public/` map UI, not a second frontend. Keep GATI running on your
Mac, connect the Mac and iPhone to the same Wi-Fi, then:

```bash
npm run ios:sync
```

```bash
npm run ios:lan
```

```bash
npm run ios:open
```

`ios:sync` must run **before** `ios:open` on a fresh clone: it vendors Leaflet and
copies the web assets into `ios/App/App/public`, which is gitignored because
Capacitor regenerates it.

In Xcode, select your iPhone, choose your Apple Development Team under the `App`
target's **Signing & Capabilities**, and press Run. On first launch the app shows
a setup screen — enter the address printed by `npm run ios:lan`, preferring the
`http://<your-mac>.local:5050` form it lists first, because that keeps working
after your router hands the Mac a different IP. The app checks `/api/health` at
that address before saving it, and the `⌁` button in the app changes it later.

#### App icon

The home-screen icon is `app-logo.webp`, installed into the asset catalogue by:

```bash
npm run ios:icon -- app-logo.webp
```

Xcode 14+ derives every icon size from a single 1024×1024 image, so that is the
only file to replace. The script validates what Xcode reports only as an opaque
"unassigned children" warning — it rejects non-square or under-1024 sources,
converts any format `sips` reads (PNG, WebP, JPEG, HEIC), and flattens
transparency, since a non-opaque icon shows black through the iOS corner mask and
fails App Store validation. Pass `--crop-margin <percent>` if the artwork already
has rounded corners, so iOS does not mask it twice. Re-run `npm run ios:sync`
after changing it; if the phone still shows the old icon, delete the app and Run
again, because iOS caches icons past a reinstall.

For live-reload development you can point the WebView straight at your Mac
instead of the bundled copy:

```bash
GATI_DEV_SERVER_URL=http://your-mac.local:5050 npm run ios:sync
```

Only use that while actively developing. With a server URL set, Capacitor loads
it and **ignores the bundled web assets entirely — there is no fallback**, so a
stale address white-screens the app before the setup screen can run. Re-run plain
`npm run ios:sync` to go back to the bundled default.

The iOS wrapper permits local HTTP only for device testing; use HTTPS before any
distribution beyond your local network. The live map **and** the `/admin` console
both work on the phone, because the Node gateway serves both and proxies the model
server-side. The Python engine binds loopback only, so its raw JSON endpoints stay
Mac-only unless you start it with `GATI_MODEL_HOST=0.0.0.0`.

---

## 🗺️ Offline map pack (optional, for demos on weak wifi)

The Leaflet map loads basemap tiles from CDNs by default. To make it work with
**no network**, build a local tile pack. Both steps below need internet and are
run **once**; nothing here is committed to git (`public/tiles/` and
`public/vendor/` are gitignored).

**Current state: the pipeline ships, the tiles do not.** Without these steps
every local tile 404s and the map transparently falls back to the CDN — i.e.
identical to today's online behaviour. The map is *not* offline-capable until
you run them.

### 1. Vendor Leaflet locally
Otherwise Leaflet itself is fetched from unpkg, and with no network the map
never renders at all.
```bash
npm install leaflet && mkdir -p public/vendor && cp -r node_modules/leaflet/dist public/vendor/leaflet
```

### 2. Build the tile pack
Check the size first — `--dry-run` makes **no** network requests:
```bash
python3 fetch_tiles.py --source maptiler-streets --key YOUR_KEY --dry-run
```
Default corridor (lat 12.5–19.3, lng 72.6–75.1) at 22 KB/tile:
**z6–z11 = 855 tiles ≈ 18 MB**, **z6–z12 = 3,204 tiles ≈ 69 MB**. Then fetch:
```bash
python3 fetch_tiles.py --source maptiler-streets --key YOUR_KEY --max-zoom 11 --yes
```
The run is cache-first and resumable — re-run the same command to retry
failures or fill in a partial pack. It finishes by writing
`public/tiles/pack.json`, the manifest the map reads on load: **no code change
is needed.** Layers listed there are served from disk (with per-tile CDN
fallback for gaps) and zooming past the packed maximum upscales local tiles
instead of showing blanks. Layers absent from it skip the local lookup
entirely, so a pack-less install makes no wasted requests.

Run it once per layer you want offline (`--layer satellite`, `--layer dark`, …);
the manifest is merged, not overwritten.

### Choosing a source
`fetch_tiles.py` **refuses** to bulk-download from Esri, CARTO and
OpenRailwayMap: showing their tiles interactively is fine, but caching them to
disk in bulk breaks their terms. Use a provider that permits offline caching —
`maptiler-satellite`, `maptiler-streets`, `maptiler-dark`, `stadia-dark`,
`thunderforest-transport` (all keyed, free tiers available) — or point
`--url-template` at your own render. The `osm` preset is capped at 5,000 tiles
and single-connection per the OSMF Tile Usage Policy.

Whatever you choose, **keep its attribution visible in the UI** — the script
prints the required string, and it belongs in the layer's `attribution` option
in `public/app.js` → `initMap()`. Run `python3 fetch_tiles.py --help` for all
options (`--bbox`, `--layer`, `--concurrency`, …).

### Verify it works offline
Load `http://localhost:5050`, then turn off wifi (or tick *Offline* in DevTools →
Network) and reload. The map shell and packed zoom levels should render entirely
from disk.

---

## 🚇 Tunnel data (Konkan Railway)

The live map shows all **69 tunnels** on the Mumbai CSMT – Madgaon alignment and,
for the selected train, which one it is inside plus the distance and time to the
exit. The dataset is built offline from a CSV of OpenStreetMap way geometry:

```bash
python3 build_tunnels.py --dry-run
```

That audits without writing anything — it prints the parsed rows, the length
distribution, the validation deltas against published KRCL figures, the portal
projection offsets, and every data defect found. Drop `--dry-run` to write
`src/data/konkan-tunnels.json`, or pass a path to use a different CSV:

```bash
python3 build_tunnels.py path/to/tunnels.csv
```

The CSV needs the columns `Tunnel No`, `Tunnel Name`, `Start Lat`, `Start Lon`,
`End Lat`, `End Lon`, `OSM Way Segments`. No network access is used.

**What the numbers mean.** Tunnel length is the portal-to-portal great-circle
**chord**, which matches published KRCL lengths to within 1.1% across the five
tunnels with public figures. This is **OpenStreetMap data, not official KRCL
alignment data** — `_meta.sourceIsOfficial` is `false` and the UI says so.
Time-to-exit is computed from the **schedule-derived** block speed
(`speedToNextStationKmph`), because the upstream API exposes no live speed; the
UI never shows the minutes without that caveat attached.

Known defects in the source CSV are recorded in `_meta` rather than quietly
patched: tunnel `#66` is duplicated, numbers 67–69 are missing, and `36A` means
tunnel numbers are strings. Nothing is renumbered or invented.

---

## 🔀 Crossing prediction (single-line loop holds)

On single track, a train can stand in a loop for 15–25 minutes purely because
another train has precedence — a delay cause that no timetable-plus-buffer ETA
can see. GATI predicts these meets **hours ahead**, because they fall out of two
static timetables plus our train's current delay.

**This costs no extra upstream requests.** The other trains' times are
*scheduled* and therefore immutable, so they are read from the timetables already
in `.cache/`. Only our own delay is live, and we already fetch it.

### 1. Build the corridor index (offline, no network)

```bash
python3 scripts/build_corridor.py --dry-run
```

That audits without writing: it prints every cached train, its normalised type,
station and halt counts, km span and time span, and each file it skips and why.
Drop `--dry-run` to write `.cache/corridor/{train}.json` — **17 trains** from the
18 files matching `.cache/train_*_live_fallback.json` (`fleet_fallback.json` is a
fleet array, not a train, and is skipped by name).

All times are normalised to `(day − 1) × 1440 + minutes-since-midnight` using
`arrivalDay`/`departureDay`, because the cached runs come from four different
service dates — comparing raw ISO timestamps finds nothing.

### 2. Query the model

```bash
python3 conflict.py --train 12051                 # on the scheduled timetable
python3 conflict.py --train 12051 --delay 45      # 45 min late
python3 conflict.py --train 10103 --json          # machine-readable
```

`12051` (Shatabdi) on time meets five opposing trains and wins all five — total
hold **0 min**, with the *other* train looped 16–31 min at each meet. `10103`
Mandovi (Mail/Express) is **held twice for 40 min**: 15 min for 12617 Superfast on
the Indapur–Mangaon section, 25 min for 12052 Jan Shatabdi on Vilavade–Rajapur
Road. Both outcomes are always reported; a crossing we win is as much a
prediction as one we lose.

Delay **moves** every meet point — that is the predictive payload. Each row
carries `scheduledMeetKm` and `shiftKm` so the UI can say "this meet moved 12 km
earlier than planned" rather than just naming a station.

`--offsets` (default `0,-1,-2`) sets which departure days are scanned for other
trains' instances. **Leave it alone unless you know why**: 12617, 16346 and 01132
occupy the Konkan corridor on *their own day 2*, so scanning only today finds 2 of
the 5 crossings.

### 3. Verify

```bash
python3 verify_conflicts.py
```

Offline invariant suite — 8 trains × 6 delays, **174 conflict rows**, asserting
properties that must hold for any train and any delay: every meet inside the
single-line section, no negative holds, never both trains held, no duplicate
meets, shift figures reconciling against their own baseline, reciprocity (a meet
found from 12051's view must appear from 12052's, at the mirrored chainage, with
both sides agreeing on who waits), and the type-ladder ordering.

### What is real and what is assumed

| | |
| :--- | :--- |
| **Real** | Both trains' timetables, the chainage join on station code, the meet-point geometry (sign flip in `our_time − their_time`, linearly interpolated), and our own live delay. |
| **Assumed** | Loop **locations** — every timetable station on the single-line section is treated as able to host a crossing. This source carries no track-count or loop-length data (`loopBasis: "assumed-all-stations"`, `loopDataIsOfficial: false`). |
| **Heuristic** | Precedence, ranked over the `train.type` string (Vande Bharat/Rajdhani 1 → Shatabdi 2 → Jan Shatabdi 3 → Superfast 4 → Mail/Express 5 → other 6). This is **not** official Indian Railways precedence — the real call is a Section Controller's. |
| **Constant** | `REACCEL_MIN = 3.0` min for loop entry/exit and restarting from a dead stand. Surfaced in the payload, not buried in a formula. |
| **Scope** | Only the Konkan section is single line. CSMT → **Roha** is Central Railway double line and needs no hold; the boundary is anchored by station **code**, not a km constant, so it lands correctly on both up and down trains. |

Same-direction **overtakes are delay-conditional and show nothing in normal
running** — that is correct, not a wiring failure. The timetable is built so
faster trains depart first, precisely because an overtake costs a long loop
occupancy on single track. 22229 needs about **+150 min** before it catches 10103,
and the overtake point then moves with the delay. Such a meet reports
`existsOnTime: false` (the delay *created* it) rather than a shift from a planned
crossing that never existed.

**Prediction only.** `_meta.decisionSupportOnly` is `true`. Nothing here is
dispatched, and every alert is for a human controller to confirm.

---

## 📡 Available API Endpoints

| Method | Endpoint | Description | Cache TTL |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/health` | Server health & API key configuration state | No cache |
| `GET` | `/api/trains/:trainNumber/live` | Real-time train running status, delays, current position, tunnel state, crossing predictions | **No cache** (`CACHE_TTL_LIVE=0`) |
| `GET` | `/api/trains/radar/fleet` | Live positions for the configured fleet, interpolated along each polyline | **No cache** (`CACHE_TTL_LIVE=0`) |
| `GET` | `/api/tunnels/zones` | The 69 Konkan tunnels (static list, no train context) | 1 hour |
| `GET` | `/api/trains/:trainNumber` | Train timetable, halts, and full schedule | 24 hours |
| `GET` | `/api/trains/:trainNumber/route` | GeoJSON route geometry coordinates for maps | 24 hours |
| `GET` | `/api/trains/:trainNumber/coaches` | Coach composition and seating layout | 24 hours |
| `GET` | `/api/trains/search?q=:query` | Autocomplete search for trains by name or number | 24 hours |
| `GET` | `/api/lookup/categories` | Train category metadata list | 24 hours |
| `ALL` | `/api/proxy/*` | Transparent proxy forwarding to any RailRadar endpoint | Variable |

Static TTLs read `CACHE_TTL_STATIC` (default 86400 s). That the static tier stays
long while the live tier is 0 is **deliberate** — see the note at
`src/config/env.js:143`; do not "fix" one to match the other.

The Python engine on `:8000` additionally serves `GET /eta/{train}?date=&weather=&mode=`,
`/eta/{train}/curvature`, `/conflicts/{train}?delay=&offsets=`,
`/corridor/conflicts?date=&at=&window=&limit=&delay=`, `/geometry/{train}?max_points=`
and `/health`. It is a **pure JSON service** — it serves no HTML.

The gateway proxies the model at `/api/model/eta/:train`, `/api/model/health` and
`/api/model/geometry/:train` (the admin console uses these; FastAPI has no CORS
middleware, so a browser on `:5050` cannot call `:8000` directly). `POST
/api/admin/cache/flush` clears the gateway's in-memory cache only and never touches
`.cache/`.

The gateway calls `/conflicts/{train}` itself on every live request and attaches
the result to the payload as `conflicts`, tagged `delayBasis: "live"`. When the
live call falls back to `.cache/`, the block is **recomputed** from the cached
delay and tagged `delayBasis: "cached"` — a conflict prediction is derived from a
delay at one instant, so it is never persisted to disk and re-served as current.
If the model is unreachable or has no corridor entry for the train, the payload
carries `conflictsUnavailable` with the reason instead; the UI names the absent
case rather than rendering an empty panel that looks like "no crossings".

---

## 💻 Example Requests

Replace `5050` with whatever port the startup banner printed.

### 1. Live Running Status
```bash
curl http://localhost:5050/api/trains/12002/live
```

### 2. Train Timetable & Halts
```bash
curl http://localhost:5050/api/trains/12002
```

### 3. Train Search
```bash
curl "http://localhost:5050/api/trains/search?q=Shatabdi"
```

### 4. Health Check
```bash
curl http://localhost:5050/api/health
```

### 5. Full ETA-layer integration check
Needs **both** processes up; prints every layer's contribution per segment.
```bash
python3 verify_integration.py
```

### 6. Crossing prediction (Python engine, port 8000)
```bash
curl "http://localhost:8000/conflicts/12051?delay=45"
```

---

## 📁 Project Structure

```
.
├── .env                  # Environment variables & API key (gitignored)
├── .env.example          # Sample environment template
├── package.json          # Project configuration & dependencies
├── capacitor.config.ts   # iOS wrapper config (bundled by default; see "Test on iPhone")
├── app-logo.webp         # App-icon source (1254x1254; see "App icon")
├── fetch_tiles.py        # Builds the offline map pack into public/tiles/
├── build_tunnels.py      # Konkan tunnel CSV -> src/data/konkan-tunnels.json (offline)
├── conflict.py           # Crossing/overtake + loop-hold model (cache-only, offline)
├── verify_conflicts.py   # Invariant suite for conflict.py (offline, 174 rows)
├── run_server.py         # Hardened launcher for the Python ETA engine (:8000)
├── scripts/
│   ├── serve.js          # Starts the Python engine and Node gateway together
│   ├── build_corridor.py # Cached timetables -> .cache/corridor/ (offline, no network)
│   ├── prepare-ios-web.js# Vendors Leaflet + prunes .DS_Store before `cap sync`
│   ├── set-app-icon.js   # Installs + validates the 1024x1024 iOS app icon
│   └── ios-lan-url.js    # Prints the LAN address to enter in the iPhone app
├── ios/                  # Capacitor iOS project (build output gitignored)
├── public/
│   ├── index.html        # Leaflet live-map UI (loads Leaflet local-first)
│   ├── app.js            # Map engine, fleet polling, drawer & telemetry
│   ├── app.css           # UI styles (incl. iOS safe-area insets)
│   ├── offline-tiles.js  # Offline-first tile layer (local pack → CDN fallback)
│   ├── tiles/            # Offline tile pack + pack.json manifest (gitignored)
│   └── vendor/           # Vendored Leaflet (gitignored; see "Offline map pack")
├── src/
│   ├── config/
│   │   └── env.js        # Environment config loader & validation
│   ├── controllers/
│   │   └── train.controller.js # Request handlers for train endpoints
│   ├── middleware/
│   │   ├── cache.js      # In-memory TTL caching middleware
│   │   ├── errorHandler.js # Centralized JSON error handling
│   │   └── rateLimiter.js# Rate limiting middleware
│   ├── routes/
│   │   └── api.routes.js # REST API route declarations
│   ├── data/
│   │   ├── konkan-tunnels.json # 69 Konkan tunnels (built by build_tunnels.py)
│   │   └── speed-history.json  # Observed tunnel transits (empty until EMA runs)
│   ├── services/
│   │   ├── railradar.js  # RailRadar API HTTP client wrapper
│   │   ├── tunnels.js    # Tunnel chainage projection & containment
│   │   └── deadReckoning.js # Tunnel state + GPS-blind-spot dead reckoning
│   └── server.js         # Express main entry point
└── README.md
```
