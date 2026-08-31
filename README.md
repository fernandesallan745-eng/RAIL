# 🚄 RailRadar API Backend Proxy

A robust, modular Node.js & Express backend proxy server for the [RailRadar API](https://railradar.in/docs) (Indian Railways data).

## 🌟 Key Features

- **Secure API Key Management**: Loads your `RAILRADAR_API_KEY` from `.env` and automatically handles `Bearer` token authorization headers for every upstream request.
- **Smart Response Caching**: In-memory TTL caching with `node-cache` (60s for live running status, 1hr for static schedules/routes) to avoid burning API rate limits and conserve API credits.
- **Rate Limiting & Protection**: Built-in `express-rate-limit` to prevent request flooding.
- **Error Resilience**: Intercepts upstream RailRadar errors (401, 404, 429, 504 timeouts) and formats them into clean, structured JSON responses.
- **Interactive Developer Explorer**: A built-in dark-mode web dashboard at `http://localhost:5000` to test train numbers, view real-time delays, inspect route geometries, and copy responses.
- **Generic Proxy Support**: Transparently proxies any custom RailRadar subpath via `/api/proxy/*`.

---

## 🚀 Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Your API Key
Open `.env` and add your RailRadar API key:
```env
PORT=5000
RAILRADAR_API_KEY=your_railradar_api_key_here
RAILRADAR_BASE_URL=https://api.railradar.in/v1
```

### 3. Start the Server
```bash
# Production mode
npm start

# Development mode (with auto-reload)
npm run dev
```

Visit **`http://localhost:5000`** in your browser to open the interactive API tester.

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
Load `http://localhost:5000`, then turn off wifi (or tick *Offline* in DevTools →
Network) and reload. The map shell and packed zoom levels should render entirely
from disk.

---

## 📡 Available API Endpoints

| Method | Endpoint | Description | Cache TTL |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/health` | Server health & API key configuration state | No cache |
| `GET` | `/api/trains/:trainNumber/live` | Real-time train running status, delays, current position | 60 seconds |
| `GET` | `/api/trains/:trainNumber` | Train timetable, halts, and full schedule | 1 hour |
| `GET` | `/api/trains/:trainNumber/route` | GeoJSON route geometry coordinates for maps | 1 hour |
| `GET` | `/api/trains/:trainNumber/coaches` | Coach composition and seating layout | 1 hour |
| `GET` | `/api/trains/search?q=:query` | Autocomplete search for trains by name or number | 1 hour |
| `GET` | `/api/lookup/categories` | Train category metadata list | 24 hours |
| `ALL` | `/api/proxy/*` | Transparent proxy forwarding to any RailRadar endpoint | Variable |

---

## 💻 Example Requests

### 1. Live Running Status
```bash
curl http://localhost:5000/api/trains/12002/live
```

### 2. Train Timetable & Halts
```bash
curl http://localhost:5000/api/trains/12002
```

### 3. Train Search
```bash
curl "http://localhost:5000/api/trains/search?q=Shatabdi"
```

### 4. Health Check
```bash
curl http://localhost:5000/api/health
```

---

## 📁 Project Structure

```
.
├── .env                  # Environment variables & API key (gitignored)
├── .env.example          # Sample environment template
├── package.json          # Project configuration & dependencies
├── fetch_tiles.py        # Builds the offline map pack into public/tiles/
├── public/
│   ├── index.html        # Leaflet live-map UI (loads Leaflet local-first)
│   ├── app.js            # Map engine, fleet polling, drawer & telemetry
│   ├── app.css           # UI styles
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
│   ├── services/
│   │   └── railradar.js  # RailRadar API HTTP client wrapper
│   └── server.js         # Express main entry point
└── README.md
```
