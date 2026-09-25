# 🛠️ GATI — Architecture, Stack, Data Storage & Security

This document outlines the complete technology stack, data storage mechanisms, and security model **actually used** in this project. Nothing hypothetical or planned is included here.

---

## 1. System Overview

GATI runs as a local, decoupled dual-runtime system:

1. **Node.js Gateway (`:5050`)** — Network boundary, rate-governed upstream proxy to RailRadar, session caching, tunnel chainage projection, dead reckoning, and crowdsourced hazard store.
2. **Python Numerical Engine (`:8000`)** — Cache-only FastAPI service computing physics-based track curvature, timetables, conflict prediction, terminal constraints, and the multi-layer additive ETA ladder.
3. **Zero-Build Client** — Vanilla HTML/CSS/JS served directly from `/public` to browsers and wrapped natively for iOS via Capacitor.

```
┌────────────────────────────────────────────────────────┐
│  Frontend (Browser / iOS Capacitor Native Container)   │
│  Vanilla ES6+ JS · Vanilla CSS3 · HTML5 · Leaflet 1.9.4│
└───────────────────────────┬────────────────────────────┘
                            │ HTTP / REST (:5050)
                            ▼
┌────────────────────────────────────────────────────────┐
│  Backend 1: Node.js Express Gateway (:5050)            │
│  • Express 4.21.2 · Axios 1.7.9 · NodeCache 5.1.2      │
│  • Upstream Rate Governor (≤9 req/min, jitter backoff) │
│  • Hazard Store & Verification (src/data/hazards.json) │
│  • Tunnel Projection & Dead Reckoning                  │
└───────────────────────────┬────────────────────────────┘
                            │ HTTP Internal (:8000)
                            ▼
┌────────────────────────────────────────────────────────┐
│  Backend 2: Python FastAPI Engine (:8000)              │
│  • FastAPI · Uvicorn (Cache-only, 0 upstream calls)   │
│  • Pure Python stdlib (math, json, datetime)           │
│  • Curvature Physics (RDSO formula) & Conflict Loops   │
└────────────────────────────────────────────────────────┘
```

---

## 2. Frontend Technology Stack

* **Core**: Vanilla HTML5, Vanilla ES6+ JavaScript.
  * No frontend frameworks (no React, Vue, Angular, or Svelte).
  * No bundlers, transpilers, or build steps (no Webpack, Vite, Rollup, or Babel).
  * Direct DOM updates.
* **Styling**: Vanilla CSS3 (`public/app.css`, `public/admin.css`).
  * Custom CSS variables for theme tokens.
  * Flexbox and CSS Grid for layout.
  * Glassmorphic dark styling (`#080b11`, `#0f172a`).
  * No CSS libraries (no Tailwind, Bootstrap, or Sass).
* **Interactive Mapping**: Leaflet 1.9.4 (`public/vendor/leaflet/leaflet.js`).
  * Local-first loading with automated unpkg CDN fallback if local assets are missing.
  * Custom `L.TileLayer` subclass (`public/offline-tiles.js`) supporting local disk tiles via `/tiles/pack.json`.
* **Mobile App (iOS)**: Capacitor 8.
  * Wraps the exact same `public/` directory into a native iOS app.
  * Swift Package Manager (no CocoaPods).
  * Local storage of gateway LAN address for live on-device testing.

---

## 3. Backend Technology Stack

### 3.1 Node.js Gateway (Port 5050)
* **Runtime**: Node.js (v18+, ES Modules).
* **Framework**: Express (`^4.21.2`).
* **HTTP Client**: Axios (`^1.7.9`) — encapsulated in a module-private instance to prevent unthrottled upstream leaks.
* **In-Memory Caching**: `node-cache` (`^5.1.2`).
  * Static tier: 86,400s (24 hours) for schedules/routes.
  * Live tier: `0s` by default (`CACHE_TTL_LIVE=0`) to ensure live positions are never served stale.
* **Rate Limiting**: `express-rate-limit` (`^7.5.0`).
* **Environment & Config**: `dotenv` (`^16.4.7`).
* **HTTP Logging**: `morgan` (`^1.10.0`).
* **Cross-Origin**: `cors` (`^2.8.5`).

### 3.2 Python Numerical Engine (Port 8000)
* **Runtime**: Python 3.10+.
* **Web Framework**: FastAPI.
* **ASGI Server**: Uvicorn with `h11`.
* **WebSocket Push**: Native FastAPI WebSocket (`/ws/eta/{train}`).
* **Numerical & Algorithmic Modules**:
  * **100% Python Standard Library** (`math`, `json`, `datetime`, `glob`, `re`, `os`).
  * No external data science libraries (no pandas, NumPy, or SciPy) — algorithms remain lightweight and auditable.
  * `requests` is used strictly in offline fetch scripts, never by the runtime engine.

---

## 4. How User & Application Data Is Stored

There is **no standalone database server** (no PostgreSQL, MySQL, MongoDB, Redis, or SQLite). All persistence uses local structured files and memory caches:

### 4.1 User-Submitted Data (Crowdsourced Hazards)
* **Storage Location**: `src/data/hazards.json`.
* **Storage Format**: Flat JSON array of reports with immutable UUIDs and append-only audit histories.
* **Crash-Resilient Atomic Writes**:
  * Every write creates a temporary file (`.hazards.json.tmp`) and executes `fs.renameSync()`.
  * Because `rename(2)` is atomic on POSIX filesystems, a process crash or sudden shutdown can never produce a corrupted or half-written JSON file.
* **In-Memory Sync**: Loaded into memory on startup (`loadStore()`) for zero-latency retrieval, and updated synchronously during writes.
* **Photo Storage**:
  * Stored on the local filesystem in `src/data/hazard-photos/`.
  * Filenames are derived from SHA-256 hashes of the file contents.
  * Uploaded images are limited to JPEG/PNG, downscaled client-side, and capped at 600 KB decoded size.

### 4.2 Client-Side Storage (`localStorage`)
The frontend stores only anonymous operational keys in the user's browser `localStorage`:
* `gati:server_url`: Optional LAN address of the server when running on iOS devices.
* `hazard_device_id`: A randomly generated anonymous UUID (`anon-...`) used solely to cluster independent corroborating reports. No personal identity is ever stored.
* `hazard_last_submit`: Local timestamp used to prevent accidental double-taps.

### 4.3 Cached Operational & Train Data
* **Corpus & Schedules**: `.cache/*.json`
  * Historical runs, timetables, and GeoJSON route coordinates obtained from RailRadar API.
  * Read-only at runtime by both Node.js and Python engines.
* **Tunnel Reference Data**: `src/data/konkan-tunnels.json`
  * Offline-parsed portal coordinates and lengths for 69 Konkan Railway tunnels.

---

## 5. Security Architecture

### 5.1 Authentication & Authorization
* **Public Access**: Live map, timetable viewing, and hazard submissions require no login or account.
* **Admin Actions (Operator Decision Token)**:
  * Approving or rejecting hazard reports requires the `x-admin-token` HTTP header (or `Bearer` token).
  * **Timing Attack Prevention**: Uses Node.js `crypto.timingSafeEqual()` on SHA-256 hashes of the provided token vs. `GATI_ADMIN_TOKEN`:
    ```javascript
    const a = crypto.createHash('sha256').update(supplied).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    crypto.timingSafeEqual(a, b);
    ```
  * **Zero Token Leakage**: The token value is held only in the browser form field; it is never saved to `localStorage`, never logged to stdout/files, and never echoed back in API responses.

### 5.2 API Key Protection
* Upstream `RAILRADAR_API_KEY`s reside strictly on the server in `.env`.
* The Axios HTTP client is module-private within `src/services/railradar.js`. It is never exposed to frontend code or client requests.

### 5.3 Input Sanitization & Attack Mitigation
* **Cross-Site Scripting (XSS)**:
  * All user-provided strings and API outputs are sanitized through `escapeHtml()` before insertion into the DOM.
* **Control Character Filtering**:
  * Free-text hazard descriptions strip non-printable ASCII control characters (`/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g`) to prevent terminal injection and JSON corruption.
* **Geographical Bounding Box Validation**:
  * Coordinates must fall within the Konkan corridor bounding box (Lat 12.0–19.6, Lng 72.3–75.6). Out-of-bounds inputs or browser errors (e.g., `0,0` Null Island) are rejected at the API boundary.
* **Category Enforcement**:
  * Only predefined hazard category identifiers (`engine-failure`, `landslide`, etc.) are permitted.

### 5.4 Abuse Prevention & Rate Limiting
* **General API Limiter**: Enforces 2,000 requests per 15-minute window per IP (`express-rate-limit`) to prevent abuse while supporting dashboard auto-refresh.
* **Hazard Submission Limiter**: Strictly capped at 10 submissions per 15 minutes per IP.
* **Admin Decision Limiter**: Capped at 60 actions per 15 minutes per IP to prevent token brute-forcing.
* **Request Body Caps**:
  * Global express parser: `100 KB`.
  * Dedicated photo upload route: scoped to `1 MB` (`HAZARD_MAX_BODY_BYTES`), rejecting oversized payload floods before memory exhaustion.
* **Outbound Upstream Rate Governor**:
  * A serialized queue strictly limits outbound calls to ≤9 requests per 60 seconds with equal-jitter backoff and a shared 429 cooldown, protecting the server against external API bans.
