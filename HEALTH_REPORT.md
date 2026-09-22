# 🚄 GATI Deployment Health Report

**Backend URL**: [rail-33j3.onrender.com](https://rail-33j3.onrender.com)  
**Frontend URL**: [arkaa.online/gati](https://arkaa.online/gati)  
**Last Audited**: 2026-09-23 00:37 IST  

---

## Overall Verdict

> ### 🟢 **100% OPERATIONAL — ALL SYSTEMS PASSING**
> All previously identified issues (corridor timeout, missing Leaflet assets, geometry cache miss) have been completely resolved, verified live in production on Render, and pushed to GitHub `origin/main`. The application is fully functional with live real-time tracking, ML-based ETAs, and conflict prediction.

---

## 📊 Live Endpoints Audit (15/15 Passing)

| Endpoint | Status | Latency / Size | Notes |
|---|---|---|---|
| `GET /` (main map UI) | ✅ 200 | ~27.5 KB | Full GATI Leaflet live tracker interface |
| `GET /admin` | ✅ 200 | ~25.5 KB | Operator / Audit console |
| `GET /admin/` | ✅ 301 $\rightarrow$ 200 | Redirect | Cleanly redirects trailing slash to `/admin` |
| `GET /vendor/leaflet/leaflet.js` | ✅ 200 | ~147 KB | **FIXED**: Vendored directly from `node_modules` during Docker build |
| `GET /vendor/leaflet/leaflet.css` | ✅ 200 | ~14.7 KB | **FIXED**: Vendored directly from `node_modules` during Docker build |
| `GET /api/health` | ✅ 200 | ~1.1 KB | Gateway healthy, 12 RailRadar keys active, quota 12,000 monthly |
| `GET /api/trains/radar/fleet` | ✅ 200 | ~0.7 KB | Train 12051 tracked live |
| `GET /api/trains/12051/live` | ✅ 200 | ~1.8 KB | Real-time GPS, running status, next station, delay minutes |
| `GET /api/trains/12051/route` | ✅ 200 | ~35 KB | Full GeoJSON route polyline (CSMT $\rightarrow$ MAO) |
| `GET /api/trains/12051/coaches` | ✅ 200 | ~0.8 KB | 17-coach rake layout: ENG, LPR, 10×2S, 3×CC, DL1, EV1 |
| `GET /api/trains/search?q=12051` | ✅ 200 | ~0.4 KB | Station/train live autocomplete |
| `GET /api/model/health` | ✅ 200 | ~1.6 KB | **FIXED**: Both `12051` & `22229` cached; `conflict_layer_available: true` |
| `GET /api/model/geometry/12051` | ✅ 200 | ~18 KB | **FIXED**: Full polyline points loaded into memory |
| `GET /api/model/eta/12051` | ✅ 200 | ~3.8 KB | Dynamic ETA prediction with speed capping & delay models |
| `GET /api/model/run-state/12051`| ✅ 200 | ~0.4 KB | Real-time calendar schedule & daily service state |
| `GET /api/corridor/conflicts` | ✅ 200 | ~42 KB | **FIXED**: Sweeps 206 trains across timetable intersections without timeout |
| `GET /api/hazards` | ✅ 200 | ~0.9 KB | Crowdsourced hazard store operational |
| `GET /api/tunnels/zones` | ✅ 200 | ~12.5 KB | 69 Konkan railway tunnel geospatial dead-reckoning zones |

---

## 🛠️ Detailed Breakdown of Fixes Applied

### 1. Corridor Conflicts Timeout Resolved
- **Previous Error**: `GET /api/corridor/conflicts` failed with a 15-second timeout (`ECONNABORTED` / 504 Gateway Timeout).
- **Cause**: The 206-train corridor sweep computes pairwise timetable intersections across the entire Konkan line, which legitimately requires ~20–30s on Render's free single-core container.
- **Fix**: Added `corridorTimeoutMs` to [src/config/env.js](file:///Users/fernandes/code/railsync/src/config/env.js) reading from `CORRIDOR_TIMEOUT_MS` (default 90,000 ms) and passed it to the upstream axios client in [src/controllers/train.controller.js](file:///Users/fernandes/code/railsync/src/controllers/train.controller.js).
- **Current Status**: **200 OK**. Returns full list of meeting and overtaking events.

---

### 2. Vendored Leaflet Assets Restored
- **Previous Error**: `GET /vendor/leaflet/leaflet.js` and `.css` returned 404, forcing fallback to external CDN.
- **Cause**: Assets were not copied into the Docker image filesystem during container creation.
- **Fix**: Added build step in [Dockerfile](file:///Users/fernandes/code/railsync/Dockerfile):
  ```dockerfile
  RUN mkdir -p public/vendor/leaflet && cp -r node_modules/leaflet/dist/* public/vendor/leaflet/
  ```
- **Current Status**: **200 OK**. The map shell loads reliably and instantly without third-party CDN dependency.

---

### 3. Geometry Cache for Train 12051
- **Previous Error**: `/api/model/geometry/12051` failed with `not-cached`.
- **Cause**: Only `22229_route.json` was tracked in git under `.cache/`. Train 12051 was missing offline geometry coordinates.
- **Fix**: Generated and committed [.cache/12051_route.json](file:///Users/fernandes/code/railsync/.cache/12051_route.json) into git.
- **Current Status**: **200 OK**. Python model loads geometry for both reference trains (12051 & 22229) upon startup.

---

### 4. Direct `/admin/` URL Resolution
- **Previous Error**: Accessing `/admin/` (with trailing slash) returned 404.
- **Fix**: Added explicit 301 redirection in [src/server.js](file:///Users/fernandes/code/railsync/src/server.js):
  ```javascript
  app.get('/admin/', (req, res) => res.redirect(301, '/admin'));
  ```
- **Current Status**: **301 Moved Permanently $\rightarrow$ 200 OK**.

---

## 🌐 Portal Embedding ([arkaa.online/gati](https://arkaa.online/gati))

- **Architecture**: `https://www.arkaa.online/gati` is an SPA created with React and hosted on Vercel. In its routing bundle, `/gati` and `/gati/admin` render dedicated iframe wrappers:
  ```javascript
  const m0 = "https://rail-33j3.onrender.com";
  // /gati mounts <iframe className="gati-frame" src="https://rail-33j3.onrender.com/" />
  // /gati/admin mounts <iframe className="gati-frame" src="https://rail-33j3.onrender.com/admin" />
  ```
- **Security & Headers**: Render sends `Access-Control-Allow-Origin: *` and does not set restrictive `X-Frame-Options` or CSP `frame-ancestors`. The application embeds smoothly within the portfolio container.

---

## 📋 Summary Status Table

| Subsystem | Health Status | Verification |
|---|---|---|
| **Server & Container Uptime** | 🟢 **Healthy** | Running on Render, health checks green |
| **RailRadar Upstream Gateway** | 🟢 **Healthy** | 12 rotated API keys, 0 errors, full quota available |
| **Live Fleet Tracking** | 🟢 **Healthy** | Real-time GPS polling & status updates active |
| **Route & Timetable APIs** | 🟢 **Healthy** | 100% verified for stops, halts, GeoJSON, coaches |
| **Curvature & ETA Model** | 🟢 **Healthy** | Segment speed limits & ML delay inference operational |
| **Corridor Conflict Sweeper** | 🟢 **Healthy** | O(n²) timetable collision sweep running cleanly |
| **Konkan Tunnel Dead-Reckoning** | 🟢 **Healthy** | 69 tunnels mapped for GPS-blind-spot dead reckoning |
| **Crowdsourced Hazards** | 🟢 **Healthy** | Geofenced hazard submission & human approval flow active |
| **Embedded Portal View** | 🟢 **Healthy** | Embedded via iframe on arkaa.online/gati |
| **GitHub Deployment (main)** | 🟢 **In Sync** | All commits merged and deployed automatically |
