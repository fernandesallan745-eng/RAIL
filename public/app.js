// RailRadar Live Map Engine
const clientCache = {
  fleet: null,
  fleetTime: 0,
  trainLive: new Map(),
  trainLiveTime: new Map(),      // timestamp per train for TTL
  trainRoute: new Map(),
  trainCoaches: new Map(),
  searches: new Map(),
};

const NATIVE_API_STORAGE_KEY = 'gati.native-api-base';
let appStarted = false;

function isNativeApp() {
  return Boolean(window.Capacitor?.isNativePlatform?.());
}

// Turns whatever was typed on a phone keyboard into a usable API base, or throws a
// message worth showing. Only caller is the server-setup form, which renders the
// thrown message directly — so every failure path needs readable wording, not a
// raw URL-constructor TypeError.
function normaliseApiBase(value) {
  const candidate = String(value || '').trim();
  if (!candidate) {
    throw new Error('Enter the address shown by `npm run ios:lan` on your Mac.');
  }
  // Check an explicit scheme BEFORE prepending. Blindly prefixing "http://" turns
  // "ftp://host:5050" into "http://ftp//host:5050", which parses cleanly with
  // hostname "ftp" — so the protocol test below would never fire and the user
  // would get a misleading "gateway did not report healthy" instead.
  const scheme = candidate.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase();
  if (scheme && scheme !== 'http' && scheme !== 'https') {
    throw new Error('Use an http:// or https:// address.');
  }
  const withProtocol = scheme ? candidate : `http://${candidate}`;
  let url;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new Error(`"${candidate}" is not a valid address. Example: http://192.168.0.100:5050`);
  }
  if (!url.hostname) {
    throw new Error('That address has no host name. Example: http://192.168.0.100:5050');
  }
  return url.toString().replace(/\/$/, '');
}

function getApiBase() {
  return localStorage.getItem(NATIVE_API_STORAGE_KEY) || '';
}

function apiUrl(path) {
  const base = getApiBase();
  return base ? `${base}${path}` : path;
}

async function fetchWithTimeout(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// Poll / client-cache intervals (milliseconds).
//
// The server no longer caches live data (CACHE_TTL_LIVE=0), so these intervals ARE the upstream
// quota spend — every tick is one real RailRadar call per train.
//
// The binding constraint is RailRadar's 10 REQUESTS PER MINUTE, not the monthly tier. Against a
// 9 req/min self-imposed ceiling (see RAILRADAR_PER_MINUTE):
//   1 train  / 60 s   =  1 req/min  =   60 req/hour
//   drawer   / 30 s   =  2 req/min  =  120 req/hour
//                        3 req/min  =  180 req/hour total  → ~33% of the allowance
//   5 keys x 1000     = 5000 req/month  ->  roughly 28 hours of continuous running
// The leftover 6 req/min is deliberate headroom: a click, a search or a manual refresh during
// the demo has to succeed immediately, not queue behind the poll loop. Shortening either
// interval, or growing FLEET_MAX_TRAINS, eats that headroom first and the month second.
// Static geometry stays cached 24 h and costs nothing per tick.
const CACHE_TTL = {
  fleet: 60 * 1000,              // 60 seconds — one upstream call per train per tick
  trainLive: 30 * 1000,          // 30 seconds — was 20 s, raised now that each tick is a real call
  trainRoute: 24 * 60 * 60 * 1000, // 24 hours (static geometry — immutable, free)
  trainCoaches: 24 * 60 * 60 * 1000, // 24 hours (static)
};

let map = null;
let currentLayer = 'satellite';
let satelliteLayersGroup = null;
let darkLayersGroup = null;
let railwayLayer = null;

let fleetMarkersLayer = null;
let activeRouteLayer = null;
let activeStationsLayer = null;
let tunnelsLayer = null;
let conflictLayer = null;
let activeTrainMarker = null;

let selectedTrainNumber = null;
let searchTimeout = null;

// Auto-refresh intervals
let fleetRefreshInterval = null;
let trainRefreshInterval = null;
let clockInterval = null;
let lastFleetUpdateTime = null;
let lastTrainUpdateTime = null;

// Initialize Application
async function bootstrapApp() {
  if (appStarted) return;
  if (isNativeApp() && !getApiBase()) {
    if (window.location.origin && /^https?:\/\//i.test(window.location.origin)) {
      localStorage.setItem(NATIVE_API_STORAGE_KEY, window.location.origin);
    } else {
      showServerSetup();
      return;
    }
  }
  appStarted = true;
  // Read /tiles/pack.json first so initMap knows which layers have local tiles
  // and to what zoom. One request; failure is non-fatal (→ CDN-only).
  if (typeof loadPackManifest === 'function') {
    await loadPackManifest();
  }
  initMap();
  loadLiveFleet();
  setupSearch();
  setupEventListeners();
  startAutoRefresh();
  startLiveClock();
  wireAuditLink();
}

// The audit console (/admin) is served by the Python FastAPI model service, not this Node
// server, so it lives on a different port. Read that port from /api/health rather than
// hardcoding a second copy of it here, and reuse the browser's own hostname so the link
// also works when the demo laptop is reached from another device on the LAN.
async function wireAuditLink() {
  const el = document.getElementById('auditLink');
  if (!el) return;
  try {
    const res = await fetch(apiUrl('/api/health'));
    const j = await res.json();
    const base = j?.modelApi?.baseUrl;
    if (!base) return;
    const u = new URL(base);
    // 127.0.0.1/localhost is correct for the SERVER; for the browser, follow this page's host
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
      u.hostname = new URL(getApiBase() || location.href).hostname;
    }
    u.pathname = '/admin';
    el.href = u.toString();
    el.hidden = false;
  } catch (e) {
    // model service unreachable → leave the link hidden rather than offering a dead one
    console.warn('[audit link] model service not reachable:', e.message);
  }
}

// index.html loads this file via an injected <script>, which does NOT delay
// DOMContentLoaded — so that event may already have fired by the time we run.
// Check readyState instead of listening unconditionally, or the map never inits.
function showServerSetup(message = '') {
  const panel = document.getElementById('serverSetup');
  const error = document.getElementById('serverSetupError');
  const address = document.getElementById('serverAddress');
  if (!panel) return;
  panel.hidden = false;
  address.value = getApiBase();
  error.textContent = message;
  error.hidden = !message;
  setTimeout(() => address.focus(), 0);
}

function hideServerSetup() {
  const panel = document.getElementById('serverSetup');
  if (panel) panel.hidden = true;
}

function setupNativeServerConnection() {
  const settingsButton = document.getElementById('serverSettingsBtn');
  const form = document.getElementById('serverSetupForm');
  if (settingsButton) {
    settingsButton.hidden = false;
    settingsButton.addEventListener('click', () => showServerSetup());
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const address = document.getElementById('serverAddress');
    const error = document.getElementById('serverSetupError');
    const submit = form.querySelector('button[type="submit"]');
    let base;
    try {
      base = normaliseApiBase(address.value);
    } catch (err) {
      showServerSetup(err.message);
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Checking connection...';
    error.hidden = true;
    try {
      const response = await fetchWithTimeout(`${base}/api/health`);
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error('The GATI gateway did not report healthy.');
      localStorage.setItem(NATIVE_API_STORAGE_KEY, base);
      hideServerSetup();
      bootstrapApp();
    } catch (err) {
      showServerSetup(`Could not reach ${base}. Confirm both devices are on the same Wi-Fi and GATI is running on your Mac.`);
    } finally {
      submit.disabled = false;
      submit.textContent = 'Connect to live tracker';
    }
  });
}

function startApp() {
  setupNativeServerConnection();
  bootstrapApp();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startApp);
} else {
  startApp();
}

// Map Initialization
function initMap() {
  // Center map on the Konkan Railway corridor (Mumbai → Goa → Mangalore)
  map = L.map('map', {
    center: [16.8, 73.5],
    zoom: 7,
    minZoom: 4,
    maxZoom: 18,
    zoomControl: false,
  });

  // Basemaps are offline-first: each tile is requested from the local pack at
  // /tiles/<layer>/{z}/{x}/{y}.png (built by fetch_tiles.py) and falls back to
  // the CDN per-tile when it is missing. With no pack present every tile falls
  // back, so online behaviour is identical to before. See public/offline-tiles.js.
  const tileLayerFactory =
    typeof createOfflineLayer === 'function'
      ? createOfflineLayer
      : (o) => L.tileLayer(o.remoteTemplate, o); // offline-tiles.js absent → plain CDN

  // Layer 1: Satellite Hybrid (Esri World Imagery + Labels)
  const esriSatellite = tileLayerFactory({
    layer: 'satellite',
    remoteTemplate:
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
    maxZoom: 18,
  });

  const esriLabels = tileLayerFactory({
    layer: 'satellite-labels',
    remoteTemplate:
      'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    attribution: '',
    maxZoom: 18,
    opacity: 0.85,
  });

  satelliteLayersGroup = L.layerGroup([esriSatellite, esriLabels]);

  // Layer 2: CartoDB Dark Matter
  darkLayersGroup = tileLayerFactory({
    layer: 'dark',
    remoteTemplate: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
    maxZoom: 18,
    subdomains: 'abcd',
  });

  // Layer 3: OpenRailwayMap overlay (Track lines)
  railwayLayer = tileLayerFactory({
    layer: 'railway',
    remoteTemplate: 'https://{s}.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png',
    maxZoom: 18,
    opacity: 0.45,
    attribution: '&copy; <a href="https://www.openrailwaymap.org/">OpenRailwayMap</a>',
  });

  // Default to Satellite View matching RailRadar
  satelliteLayersGroup.addTo(map);
  railwayLayer.addTo(map);

  // Layers for features
  fleetMarkersLayer = L.layerGroup().addTo(map);
  activeRouteLayer = L.layerGroup().addTo(map);
  activeStationsLayer = L.layerGroup().addTo(map);
  // Drawn above the route line so a tunnel reads as a section OF the route.
  tunnelsLayer = L.layerGroup().addTo(map);
  // Meet points sit above the tunnels — a crossing is a point event, and it can
  // legitimately fall inside a tunnel's span.
  conflictLayer = L.layerGroup().addTo(map);
}

// Layer Switcher
function toggleMapLayer() {
  const btn = document.getElementById('layerToggleBtn');
  const label = document.getElementById('layerToggleLabel');

  if (currentLayer === 'satellite') {
    map.removeLayer(satelliteLayersGroup);
    darkLayersGroup.addTo(map);
    currentLayer = 'dark';
    label.innerText = 'Dark';
    btn.style.backgroundImage = thumbBackground('dark', 4, 11, 7,
      'https://a.basemaps.cartocdn.com/dark_all/4/11/7.png');
  } else {
    map.removeLayer(darkLayersGroup);
    satelliteLayersGroup.addTo(map);
    currentLayer = 'satellite';
    label.innerText = 'Satellite';
    btn.style.backgroundImage = thumbBackground('satellite', 4, 11, 7,
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/4/7/11');
  }
}

// Toggle-button thumbnail: local pack tile stacked ON TOP of the CDN tile.
// CSS paints layered backgrounds front-to-back, so if the local tile 404s it
// simply isn't painted and the CDN one shows through — a free fallback with no
// JS probing. Offline with a pack, the local tile wins and no CDN request runs.
// The local URL is only listed when the manifest says that layer was built, so
// a pack-less install makes zero doomed requests.
function thumbBackground(layer, z, x, y, remoteUrl) {
  const pack = typeof getOfflinePack === 'function' ? getOfflinePack() : null;
  const hasLocal = !!(pack && pack.layers && pack.layers[layer]);
  const remote = `url('${remoteUrl}')`;
  return hasLocal ? `url('/tiles/${layer}/${z}/${x}/${y}.png'), ${remote}` : remote;
}

// Load Fleet Data from Backend (Protected with TTL-based Cache)
async function loadLiveFleet(forceRefresh = false, forceServerRefresh = false) {
  const fleetPill = document.getElementById('fleetStatusText');
  const now = Date.now();

  // If already in client cache and less than TTL old, reuse (unless forced)
  if (!forceRefresh && clientCache.fleet && now - clientCache.fleetTime < CACHE_TTL.fleet) {
    renderFleetMarkers(clientCache.fleet);
    return;
  }

  try {
    // forceRefresh bypasses only the CLIENT cache. We deliberately do NOT send
    // ?refresh=true on the periodic poll — that bypasses the server's 300s
    // node-cache and hits RailRadar upstream (20 trains/call) every minute,
    // burning the 1,000 req/month free tier in hours. Server-cache bypass is
    // opt-in via forceServerRefresh (reserved for an explicit manual refresh).
    const url = apiUrl(forceServerRefresh ? '/api/trains/radar/fleet?refresh=true' : '/api/trains/radar/fleet');
    const res = await fetch(url);
    const json = await res.json();
    if (json.success && json.data?.fleet) {
      const isUpdate = clientCache.fleet !== null;
      clientCache.fleet = json.data.fleet;
      clientCache.fleetTime = now;
      lastFleetUpdateTime = now;
      renderFleetMarkers(json.data.fleet);
      updateFleetPill(json.data.fleet.length);
      // Flash the fleet pill on refresh to show it's live
      if (isUpdate) flashElement(fleetPill?.parentElement);
    }
  } catch (err) {
    console.error('Failed to load fleet:', err);
    if (fleetPill) fleetPill.innerText = 'Radar Active (Cached)';
  }
}

// Render Fleet Markers on the Map
function renderFleetMarkers(trains) {
  fleetMarkersLayer.clearLayers();

  trains.forEach((train) => {
    if (!train.lat || !train.lng) return;

    let catClass = 'superfast';
    const typeLower = (train.type || '').toLowerCase();
    const nameLower = (train.name || '').toLowerCase();

    if (typeLower.includes('vande') || nameLower.includes('vande')) catClass = 'vande';
    else if (typeLower.includes('rajdhani') || nameLower.includes('rajdhani')) catClass = 'rajdhani';
    else if (typeLower.includes('shatabdi') || nameLower.includes('shatabdi')) catClass = 'shatabdi';

    const customIcon = L.divIcon({
      className: 'train-map-marker',
      html: `
        <div class="train-marker-body ${catClass}">
          <div class="train-marker-pulse"></div>
        </div>
      `,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });

    const marker = L.marker([train.lat, train.lng], { icon: customIcon });

    const delayText = train.delayMinutes > 0
      ? `<span style="color: #fbbf24;">+${train.delayMinutes} min</span>`
      : `<span style="color: #34d399;">On Time</span>`;

    marker.bindPopup(`
      <div class="train-popup-card">
        <div class="popup-train-num">#${train.number} &bull; ${train.type}</div>
        <div class="popup-train-name">${train.name}</div>
        <div class="popup-stats-row">
          <span title="Schedule-derived block speed (speedToNextStationKmph) — not a live GPS reading">Speed (sched): ${Math.round(train.speed || 60)} km/h</span>
          <span>Status: ${delayText}</span>
        </div>
        <div style="font-size: 0.72rem; color: #94a3b8; margin-top: 4px;">
          ${train.source} &rarr; ${train.destination}
        </div>
      </div>
    `);

    marker.on('click', () => {
      selectTrain(train.number);
    });

    fleetMarkersLayer.addLayer(marker);
  });
}

// Select and Inspect a Specific Train
async function selectTrain(trainNumber, forceRefresh = false, forceServerRefresh = false) {
  selectedTrainNumber = trainNumber;
  if (!forceRefresh) openDrawerLoading(trainNumber);

  // Start auto-refreshing this train
  startTrainAutoRefresh(trainNumber);

  try {
    const now = Date.now();

    // 1. Fetch live status WITH geometry — TTL-based cache (60s)
    //    Adding geometry=true&geometry_format=geojson embeds the route polyline
    //    in the response, so we don't need a separate /route call
    let liveData = clientCache.trainLive.get(trainNumber);
    const liveAge = now - (clientCache.trainLiveTime.get(trainNumber) || 0);
    if (!liveData || forceRefresh || liveAge > CACHE_TTL.trainLive) {
      // forceRefresh bypasses only the client cache; ?refresh=true (server-cache
      // bypass → live RailRadar upstream hit) is gated behind forceServerRefresh so
      // the 20s auto-refresh reads the server's 300s cache instead of the live API.
      const url = apiUrl(`/api/trains/${trainNumber}/live?geometry=true&geometry_format=geojson${forceServerRefresh ? '&refresh=true' : ''}`);
      const res = await fetch(url);
      const json = await res.json();
      if (!res.ok || json.success === false) {
        throw new Error(json.message || json.error || `API error (${res.status})`);
      }
      liveData = json.data?.data || json.data;
      if (liveData) {
        clientCache.trainLive.set(trainNumber, liveData);
        clientCache.trainLiveTime.set(trainNumber, now);
        lastTrainUpdateTime = now;
      }
    }

    // 2. Extract route polyline from live response geometry
    //    (or fallback to separate /route call)
    let routeGeoJson = clientCache.trainRoute.get(trainNumber);
    if (!routeGeoJson) {
      // Try to extract from the live response first
      const liveGeom = liveData?.geometry;
      if (liveGeom?.geojson?.geometry?.coordinates?.length) {
        routeGeoJson = liveGeom;
      } else {
        // Fallback: separate route endpoint
        const res = await fetch(apiUrl(`/api/trains/${trainNumber}/route`));
        const json = await res.json();
        routeGeoJson = json.data?.data || json.data;
      }
      if (routeGeoJson) clientCache.trainRoute.set(trainNumber, routeGeoJson);
    }

    // 3. Fetch coaches (long-lived cache — 24h)
    let coachesData = clientCache.trainCoaches.get(trainNumber);
    if (!coachesData) {
      const res = await fetch(apiUrl(`/api/trains/${trainNumber}/coaches`));
      const json = await res.json();
      coachesData = json.data?.data || json.data;
      if (coachesData) clientCache.trainCoaches.set(trainNumber, coachesData);
    }

    if (liveData) {
      renderTrainOnMap(liveData, routeGeoJson, forceRefresh);
      renderTrainDrawer(liveData, coachesData);
      if (forceRefresh) {
        flashElement(document.getElementById('trainDrawer'));
      }
    }
  } catch (err) {
    console.error('Failed to load train details:', err);
    document.getElementById('drawerTrainName').innerHTML = `<span style="color: #f87171; font-weight: 700; font-size: 0.85rem;">⚠️ Error: ${err.message}</span>`;
    stopTrainAutoRefresh();
    alert(`Could not load live details for train #${trainNumber}: ${err.message}`);
  }
}

// ── Tunnel overlay ──────────────────────────────────────────────────────────
// Draws the 69 real Konkan tunnels as segments of the route line. Amber = a
// tunnel the train is not in; bright cyan + pulse = the tunnel it is inside.
//
// Every number here is server-computed (src/services/tunnels.js). The client
// does no chainage arithmetic of its own — the axis correction that makes
// containment trustworthy lives on the server, and duplicating it here would
// let the two drift.
function renderTunnels(liveData) {
  const info = liveData.tunnels;
  if (!info || !Array.isArray(info.list) || !info.list.length) return;

  const insideId = info.inside?.id || null;

  for (const t of info.list) {
    const line = [
      [t.portalA.lat, t.portalA.lng],
      [t.portalB.lat, t.portalB.lng],
    ];
    const isActive = t.id === insideId;

    // Casing first so short tunnels stay visible against the magenta route.
    tunnelsLayer.addLayer(
      L.polyline(line, {
        color: isActive ? '#22d3ee' : '#f59e0b',
        weight: isActive ? 11 : 8,
        opacity: isActive ? 0.45 : 0.3,
        lineCap: 'butt',
      })
    );

    const core = L.polyline(line, {
      color: isActive ? '#67e8f9' : '#fbbf24',
      weight: isActive ? 5 : 3.5,
      opacity: isActive ? 1 : 0.85,
      lineCap: 'butt',
      // Dashed reads as "the train is out of sight in here".
      dashArray: isActive ? null : '5,4',
    });

    // Chord is the published length; the chainage span is what the containment
    // test actually uses. They differ by up to ~4% (axis renormalisation +
    // along-track vs straight-line), so both are shown rather than letting the
    // popup's own two numbers appear to contradict each other.
    const lenKm = (t.chordLengthM / 1000).toFixed(2);
    const spanKm = t.chainageLengthM != null ? (t.chainageLengthM / 1000).toFixed(2) : null;
    const conf =
      t.positionalConfidence === 'low'
        ? '<div style="color:#fbbf24;margin-top:4px;font-size:0.68rem">⚠ Position uncertainty exceeds this tunnel\'s length — identification not reliable.</div>'
        : '';
    core.bindPopup(
      `<div style="font-family:system-ui,sans-serif;min-width:190px">
         <div style="font-weight:700;font-size:0.9rem">${escapeHtml(t.name)}</div>
         <div style="color:#64748b;font-size:0.72rem;margin-bottom:6px">Tunnel #${escapeHtml(t.no)} · Konkan Railway</div>
         <div style="font-size:0.78rem">Length: <strong>${lenKm} km</strong> <span style="color:#64748b">(portal-to-portal chord)</span></div>
         <div style="font-size:0.78rem">Chainage: ${t.entryKm.toFixed(1)}–${t.exitKm.toFixed(1)} km from origin${spanKm ? ` <span style="color:#64748b">(${spanKm} km along route)</span>` : ''}</div>
         ${isActive ? '<div style="color:#0891b2;font-weight:700;margin-top:5px;font-size:0.78rem">🚆 Train is inside this tunnel</div>' : ''}
         ${conf}
       </div>`
    );

    tunnelsLayer.addLayer(core);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// ── Tunnel + blind-spot panel ───────────────────────────────────────────────
// Two independent facts, deliberately not merged:
//   liveData.tunnels        — where the train is relative to the 69 tunnels.
//                             Present in normal running; this is the useful part.
//   liveData.deadReckoning  — only when the GPS has actually gone quiet.
// A train can be inside a tunnel with a fresh fix (short bore), and can have a
// stale fix nowhere near one. Showing them as one thing would assert a causal
// link the data does not support.
function renderTunnelPanel(liveData) {
  const panel = document.getElementById('tunnelPanel');
  const header = document.getElementById('tunnelPanelHeader');
  const body = document.getElementById('tunnelPanelBody');
  const drBlock = document.getElementById('deadReckoningPanel');
  const drBadge = document.getElementById('drawerDrBadge');
  if (!panel) return;

  const info = liveData.tunnels;
  const dr = liveData.deadReckoning;
  const stale = !!(dr && dr.active);

  if (!info) {
    panel.style.display = 'none';
    if (drBadge) drBadge.style.display = 'none';
    return;
  }

  panel.style.display = 'block';
  if (drBadge) drBadge.style.display = stale ? 'block' : 'none';

  const inside = info.inside;
  // Colour tracks the SIGNAL state, not the tunnel state: red is reserved for
  // "we have lost the train", which is the condition an operator must act on.
  const accent = stale ? '#f87171' : inside ? '#22d3ee' : '#fbbf24';
  panel.style.background = stale
    ? 'rgba(239, 68, 68, 0.08)'
    : inside
      ? 'rgba(34, 211, 238, 0.08)'
      : 'rgba(251, 191, 36, 0.06)';
  panel.style.border = `1px solid ${accent}33`;
  header.style.color = accent;

  header.innerHTML = stale
    ? '<span class="pulsing-red-dot-dr"></span> SIGNAL DROPPED — position dead-reckoned'
    : inside
      ? '🚇 IN TUNNEL'
      : '🚇 Tunnel tracking';

  const rows = [];

  if (inside) {
    // Two different lengths, and they must not be silently mixed. chordLengthM
    // is the portal-to-portal straight line (the published, KRCL-validated
    // number). chainageLengthM is the tunnel's span on THIS train's timetable
    // axis, which is what metresIn/metresToExit are measured against — Karbude
    // is 6535 m chord but 6778 m of chainage. Showing only the chord would make
    // the very next line ("6777 m to exit") look like an arithmetic error, so
    // the axis length is surfaced whenever the two differ materially.
    const lenKm = (inside.chordLengthM / 1000).toFixed(2);
    const axisKm = (inside.chainageLengthM / 1000).toFixed(2);
    const lensDiffer =
      inside.chainageLengthM &&
      Math.abs(inside.chainageLengthM - inside.chordLengthM) / inside.chordLengthM > 0.02;
    rows.push(
      `Tunnel: <strong style="color:#fff">${escapeHtml(inside.name)}</strong> ` +
        `<span style="color:var(--text-dim)">#${escapeHtml(inside.no)} · ${lenKm} km chord` +
        (lensDiffer ? ` · ${axisKm} km along route` : '') +
        `</span>`
    );
    rows.push(
      `Progress: <strong style="color:#fff">${inside.metresIn} m in</strong>` +
        (inside.progressPct != null ? ` of ${Math.round(inside.chainageLengthM)} m (${inside.progressPct}%)` : '')
    );
    rows.push(
      `To daylight: <strong style="color:${accent}">${inside.metresToExit} m</strong>` +
        (inside.minutesToExit != null
          ? ` · <strong style="color:${accent}">~${inside.minutesToExit} min</strong>`
          : ' · <span style="color:var(--text-dim)">time unavailable (no speed)</span>')
    );
    if (inside.minutesToExit != null) {
      // The basis label travels with the number by design (VERIFIED #3 — there
      // is no live speed field in this payload). Never render the minutes alone.
      rows.push(
        `<span style="color:var(--text-dim);font-size:0.7rem">at ${inside.speedKmph} km/h — ` +
          `${escapeHtml(inside.speedBasisLabel || inside.speedBasis || 'unknown basis')}</span>`
      );
    }
    if (inside.positionalConfidence === 'low') {
      rows.push(
        '<span style="color:#fbbf24">⚠ Positional uncertainty exceeds this tunnel\'s ' +
          'own length — identification is not reliable.</span>'
      );
    }
  } else if (info.ahead) {
    const a = info.ahead;
    rows.push(
      `Next tunnel: <strong style="color:#fff">${escapeHtml(a.name)}</strong> ` +
        `<span style="color:var(--text-dim)">#${escapeHtml(a.no)} · ${(a.chordLengthM / 1000).toFixed(2)} km</span>`
    );
    rows.push(
      `Distance: <strong style="color:${accent}">${(a.metresToEntry / 1000).toFixed(1)} km</strong>` +
        (a.minutesToEntry != null ? ` · ~${a.minutesToEntry} min away` : '')
    );
  } else {
    rows.push('<span style="color:var(--text-dim)">No tunnels ahead on this run.</span>');
  }

  if (info.passedCount != null && info.totalCount) {
    rows.push(
      `<span style="color:var(--text-dim)">${info.passedCount} of ${info.totalCount} tunnels passed · ` +
        `${info.coverage?.totalKm ?? '?'} km of bore on this corridor</span>`
    );
  }

  // Axis provenance. 'global-scale' means the route came back without station
  // coordinates, so chainage is fitted with one scale factor instead of anchored
  // per block — a ~585 m error, longer than the median tunnel (593 m). That is
  // enough to name the wrong tunnel, so it is surfaced, not swallowed.
  if (info.axisBasis !== 'station-anchored') {
    rows.push(
      `<span style="color:#fbbf24">⚠ Chainage fitted by global scale ` +
        `(${info.axisBasis}, ${info.anchorCount} anchors) — up to ` +
        `${info.axisMismatchM ?? '?'} m of axis error, which exceeds a typical ` +
        `tunnel. Treat the identification as indicative.</span>`
    );
  }

  body.innerHTML = rows.join('<br/>');

  if (stale && drBlock) {
    drBlock.style.display = 'block';
    const staleSecs = Math.round(dr.staleSinceMs / 1000);
    const staleStr = staleSecs < 60 ? `${staleSecs}s ago` : `${Math.floor(staleSecs / 60)}m ago`;
    const clock = dr.lastSignalAt
      ? ` (${new Date(dr.lastSignalAt).toLocaleTimeString('en-IN')})`
      : '';
    document.getElementById('drLastSignal').innerText = staleStr + clock;

    const p = dr.estimatedPosition || {};
    document.getElementById('drEstPos').innerText =
      p.lat != null && p.lng != null
        ? `${p.lat.toFixed(4)}°, ${p.lng.toFixed(4)}°` +
          (p.totalDistFromOriginKm != null
            ? ` (${p.totalDistFromOriginKm.toFixed(1)} km from origin)`
            : '')
        : 'unavailable';
    document.getElementById('drConfidence').innerText =
      p.confidence != null ? `${Math.round(p.confidence * 100)}%` : 'unavailable';
  } else if (drBlock) {
    drBlock.style.display = 'none';
  }
}

// ── Crossing / overtake meet points ─────────────────────────────────────────
// One marker per predicted meet. Red = we take the loop, green = we hold
// precedence and the other train waits.
//
// As with the tunnel layer, the client does NO conflict arithmetic. Meet km,
// clock time, lat/lng, who is held, and the delay shift are all computed by
// conflict.py — including the shift, which needs a second zero-delay run and so
// cannot be derived from this payload alone.
function renderConflicts(liveData) {
  if (!conflictLayer) return;
  const info = liveData.conflicts;
  if (!info || !Array.isArray(info.conflicts)) return;

  for (const c of info.conflicts) {
    // Trains cached before the includeCoordinates fix have no station lat/lng,
    // so some meets are unmappable. Skip them here; the panel still lists them
    // and coordsNote says how many are missing — never silently drop the fact.
    if (c.meetCoordsBasis !== 'interpolated' || c.meetLat == null) continue;

    const held = c.whoIsHeld === 'us';
    const colour = held ? '#f87171' : '#34d399';

    conflictLayer.addLayer(
      L.circleMarker([c.meetLat, c.meetLng], {
        radius: 9,
        color: colour,
        weight: 2,
        fillColor: colour,
        fillOpacity: 0.25,
      })
    );

    const marker = L.circleMarker([c.meetLat, c.meetLng], {
      radius: 4.5,
      color: '#0f172a',
      weight: 1.5,
      fillColor: colour,
      fillOpacity: 1,
    });

    const holdLine = held
      ? `<div style="color:#dc2626;font-weight:700;font-size:0.78rem;margin-top:5px">` +
        `⏸ #${escapeHtml(c.ourTrain)} held ~${c.ourHoldMin} min at ${escapeHtml(c.holdStationName || c.holdStation || '?')}</div>`
      : `<div style="color:#059669;font-weight:700;font-size:0.78rem;margin-top:5px">` +
        `✓ #${escapeHtml(c.ourTrain)} has right of way — #${escapeHtml(c.otherTrain)} looped ~${c.theirHoldMin} min` +
        `${c.holdStationName ? ` at ${escapeHtml(c.holdStationName)}` : ''}</div>`;

    // "existsOnTime: false" means the delay CREATED this meet rather than moving
    // it. Every overtake is of that kind (they are zero on the scheduled
    // timetable), so the wording has to distinguish the two cases.
    const shiftLine =
      c.shiftKm != null && Math.abs(c.shiftKm) >= 0.1
        ? `<div style="font-size:0.72rem;color:#b45309;margin-top:4px">Delay moved this meet ` +
          `<strong>${Math.abs(c.shiftKm).toFixed(1)} km ${c.shiftKm < 0 ? 'earlier' : 'later'}</strong> ` +
          `(on time: km ${c.scheduledMeetKm.toFixed(1)})</div>`
        : c.existsOnTime === false
          ? `<div style="font-size:0.72rem;color:#b45309;margin-top:4px">` +
            `Does not occur on the scheduled timetable — created by the current delay.</div>`
          : '';

    marker.bindPopup(
      `<div style="font-family:system-ui,sans-serif;min-width:220px">
         <div style="font-weight:700;font-size:0.9rem">${c.kind === 'overtake' ? 'Overtake' : 'Head-on crossing'} · km ${c.meetKm.toFixed(1)}</div>
         <div style="color:#64748b;font-size:0.72rem;margin-bottom:6px">${escapeHtml(c.betweenFrom)}–${escapeHtml(c.betweenTo)} · single line · ~${escapeHtml(c.meetClock)}</div>
         <div style="font-size:0.78rem">vs <strong>#${escapeHtml(c.otherTrain)}</strong> ${escapeHtml(c.otherName || '')}</div>
         <div style="font-size:0.74rem;color:#475569">${escapeHtml(c.otherType)} (rank ${c.otherPriority}) vs our ${escapeHtml(c.ourType)} (rank ${c.ourPriority})</div>
         ${holdLine}
         ${shiftLine}
         ${c.precedenceNote ? `<div style="font-size:0.7rem;color:#64748b;margin-top:4px">${escapeHtml(c.precedenceNote)}</div>` : ''}
         <div style="font-size:0.66rem;color:#94a3b8;margin-top:6px;font-style:italic">Loop location assumed; precedence is a type heuristic. Decision support only.</div>
       </div>`
    );

    conflictLayer.addLayer(marker);
  }
}

// ── Crossing / overtake panel ───────────────────────────────────────────────
// Three states: HELD (we take the loop), RIGHT OF WAY (they do), and none
// predicted. The third is a real result on a punctual premium train and must not
// look like a failure — which is exactly why the *unavailable* case gets its own
// block instead of reusing this one.
function renderConflictPanel(liveData) {
  const panel = document.getElementById('conflictPanel');
  const header = document.getElementById('conflictPanelHeader');
  const body = document.getElementById('conflictPanelBody');
  const gapBlock = document.getElementById('conflictUnavailable');
  const gapText = document.getElementById('conflictUnavailableText');
  if (!panel) return;

  const info = liveData.conflicts;
  const gap = liveData.conflictsUnavailable;

  if (!info) {
    panel.style.display = 'none';
    if (gapBlock && gapText && gap) {
      gapBlock.style.display = 'block';
      gapText.innerHTML =
        gap.reason === 'not-in-corridor-cache'
          ? `<strong>#${escapeHtml(gap.train)}</strong> is not in the corridor schedule cache, so ` +
            `crossings cannot be computed for it. The model is running and serves the ` +
            `Konkan corridor trains — this is a data-coverage gap, not an outage.`
          : `The conflict model is not reachable, so crossing and overtake prediction is ` +
            `unavailable. Live position and tunnel tracking above are unaffected.`;
    } else if (gapBlock) {
      gapBlock.style.display = 'none';
    }
    return;
  }

  if (gapBlock) gapBlock.style.display = 'none';
  panel.style.display = 'block';

  const rows = info.conflicts || [];
  const held = info.heldCount || 0;
  const total = info.totalHoldMin || 0;

  // Amber/red only when WE lose time. A crossing we win is information, not an
  // alert — colouring it red would train the operator to ignore the colour.
  const accent = held ? '#f87171' : rows.length ? '#34d399' : '#94a3b8';
  panel.style.background = held
    ? 'rgba(239, 68, 68, 0.08)'
    : rows.length
      ? 'rgba(52, 211, 153, 0.07)'
      : 'rgba(148, 163, 184, 0.06)';
  panel.style.border = `1px solid ${accent}33`;
  header.style.color = accent;

  header.innerHTML = held
    ? `🔀 LOOP HOLD PREDICTED — ~${total.toFixed(0)} min at ${held} crossing${held > 1 ? 's' : ''}`
    : rows.length
      ? `🔀 Right of way at all ${rows.length} crossing${rows.length > 1 ? 's' : ''}`
      : '🔀 Crossing prediction';

  const out = [];

  if (!rows.length) {
    out.push(
      '<span style="color:var(--text-dim)">No crossings or overtakes predicted on the ' +
        'single-line section for this run.</span>'
    );
  } else {
    // The delay driving these meets is either a live fix or one recovered from
    // the disk cache after an upstream failure. The crossings are equally valid
    // either way — the corridor schedules are static — but a cached delay may no
    // longer be the train's actual delay, which moves every meet. Saying "live"
    // there would be the one false claim this panel could make.
    const cachedDelay = info.delayBasis === 'cached';
    const delayNote =
      info.delayMinApplied
        ? ` at ${cachedDelay ? 'a <strong style="color:#fbbf24">cached</strong>' : 'the <strong>live</strong>'} ` +
          `delay of <strong style="color:#fbbf24">+${info.delayMinApplied} min</strong>`
        : cachedDelay
          ? ' at a cached on-time position'
          : ' on the scheduled timetable';
    out.push(
      `<strong style="color:#fff">${rows.length}</strong> meet${rows.length > 1 ? 's' : ''} ` +
        `predicted${delayNote} — ` +
        `<strong style="color:#f87171">${held} held</strong> · ` +
        `<strong style="color:#34d399">${info.precedenceCount || 0} we win</strong>`
    );

    for (const r of rows) {
      const isHeld = r.whoIsHeld === 'us';
      const icon = isHeld ? '⏸' : '✓';
      const col = isHeld ? '#f87171' : '#34d399';
      const what = isHeld
        ? `<strong style="color:${col}">held ~${r.ourHoldMin} min</strong> at ${escapeHtml(r.holdStationName || r.holdStation || '?')}`
        : `<strong style="color:${col}">#${escapeHtml(r.otherTrain)} looped ~${r.theirHoldMin} min</strong>`;
      const shift =
        r.shiftKm != null && Math.abs(r.shiftKm) >= 0.1
          ? ` <span style="color:#fbbf24">(${Math.abs(r.shiftKm).toFixed(1)} km ${r.shiftKm < 0 ? 'earlier' : 'later'} than planned)</span>`
          : r.existsOnTime === false
            ? ' <span style="color:#fbbf24">(delay-created, not on the timetable)</span>'
            : '';
      out.push(
        `<span style="color:${col}">${icon}</span> km ${r.meetKm.toFixed(1)} ~${escapeHtml(r.meetClock)} · ` +
          `${r.kind === 'overtake' ? 'overtake' : 'crossing'} vs <strong style="color:#fff">#${escapeHtml(r.otherTrain)}</strong> ` +
          `<span style="color:var(--text-dim)">${escapeHtml(r.otherType)}</span> → ${what}${shift}`
      );
    }
  }

  // Coordinate coverage. Some corridor trains were cached before the
  // includeCoordinates fix (VERIFIED #13), so their meets have km and times but
  // no lat/lng and cannot be drawn. Degrade loudly, exactly like axisBasis.
  if (info.coordsNote) {
    out.push(`<span style="color:#fbbf24">⚠ ${escapeHtml(info.coordsNote)}</span>`);
  }

  body.innerHTML = out.join('<br/>');
}

// Draw Track and Stations on Map
function renderTrainOnMap(liveData, routeGeoJson, skipFlyTo = false) {
  activeRouteLayer.clearLayers();
  activeStationsLayer.clearLayers();
  tunnelsLayer.clearLayers();
  if (conflictLayer) conflictLayer.clearLayers();

  const trainInfo = liveData.train || {};
  const currentLoc = liveData.currentLocation || {};
  const routeStations = liveData.route || [];

  let coordinates = [];

  // Extract GeoJSON coordinates — handle multiple nesting levels
  // The RailRadar API returns: { geojson: { geometry: { coordinates: [...] } } }
  // But some endpoints return:  { geometry: { coordinates: [...] } }
  if (routeGeoJson) {
    let geom = null;
    if (routeGeoJson.geojson?.geometry?.coordinates) {
      geom = routeGeoJson.geojson.geometry;
    } else if (routeGeoJson.geometry?.coordinates) {
      geom = routeGeoJson.geometry;
    }
    if (geom && geom.coordinates && geom.coordinates.length > 0) {
      coordinates = geom.coordinates.map(c => [c[1], c[0]]); // [lng,lat] → [lat,lng]
    }
  }

  // Fallback to station coordinates from live status
  if (coordinates.length === 0 && routeStations.length > 0) {
    coordinates = routeStations
      .filter(s => s.lat || (s.station && s.station.lat))
      .map(s => [s.lat || s.station.lat, s.lng || s.station.lng]);
  }

  if (coordinates.length > 0) {
    // Outer glowing track line (magenta/pink like RailRadar)
    const glowLine = L.polyline(coordinates, {
      color: '#e040a0',
      weight: 7,
      opacity: 0.35,
      lineCap: 'round',
    });

    // Inner sharp track line (bright magenta)
    const coreLine = L.polyline(coordinates, {
      color: '#ec4899',
      weight: 3.5,
      opacity: 0.95,
      lineCap: 'round',
    });

    activeRouteLayer.addLayer(glowLine);
    activeRouteLayer.addLayer(coreLine);

    // Tunnels sit on top of the route line, so they must be drawn after it.
    renderTunnels(liveData);

    // Fit map bounds smoothly (skip on auto-refresh to avoid jarring the view)
    if (!skipFlyTo) {
      map.flyToBounds(coreLine.getBounds(), {
        padding: [60, 60],
        duration: 1.2,
      });
    }
  }

  // Meet points are drawn from their own interpolated lat/lng, not from the
  // polyline, so they render even when the route geometry is missing — and after
  // the tunnels, so a crossing inside a bore stays visible on top of it.
  renderConflicts(liveData);

// Plot Station Halts — interpolated along the route polyline
  let currentTrainLat = null;
  let currentTrainLng = null;

  // Total route distance from the last station's distance field
  const totalRouteDist = routeStations.length > 0
    ? Math.max(...routeStations.map(s => s.distance || 0))
    : 0;

  routeStations.forEach((s) => {
    const isPassed = s.status === 'departed' || s.status === 'arrived';
    const isCurrent = s.sequence === currentLoc.sequence || s.status === 'current';

    // Interpolate station position on polyline using its distance-from-origin
    const stationDist = s.distance || 0;
    const pos = interpolateOnPolyline(coordinates, stationDist, totalRouteDist);
    if (!pos) return;

    const [lat, lng] = pos;

    if (isCurrent) {
      currentTrainLat = lat;
      currentTrainLng = lng;
    }

    // Station Circle Marker
    if (s.isHalt) {
      const circleMarker = L.circleMarker([lat, lng], {
        radius: isCurrent ? 8 : (isPassed ? 5 : 4),
        fillColor: isCurrent ? '#ec4899' : (isPassed ? '#10b981' : '#94a3b8'),
        color: '#ffffff',
        weight: isCurrent ? 2.5 : 1.5,
        opacity: 1,
        fillOpacity: 0.9,
      });

      // Station name label
      circleMarker.bindTooltip(
        `<div style="font-weight: 700; font-size: 0.72rem; white-space: nowrap;">${s.stationName || s.stationCode}</div>`,
        {
          direction: 'right',
          offset: [8, 0],
          permanent: map.getZoom() >= 9,
          className: 'station-label-tooltip',
        }
      );

      activeStationsLayer.addLayer(circleMarker);
    }
  });

  // Interpolate LIVE train position using distanceFromOriginKm
  const trainDistKm = currentLoc.distanceFromOriginKm;
  if (trainDistKm != null && coordinates.length > 0) {
    const trainPos = interpolateOnPolyline(coordinates, trainDistKm, totalRouteDist);
    if (trainPos) {
      [currentTrainLat, currentTrainLng] = trainPos;
    }
  }

  // Pulse marker for active train location
  if (currentTrainLat && currentTrainLng) {
    const trainPulseIcon = L.divIcon({
      className: 'train-map-marker',
      html: `
        <div class="train-marker-body vande" style="width: 20px; height: 20px; border-width: 3px; border-color: #ec4899;">
          <div class="train-marker-pulse" style="border-color: #ec4899;"></div>
        </div>
      `,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });

    const delayStr = (liveData.delayMinutes || 0) > 0
      ? `<span style="color:#fbbf24;">+${liveData.delayMinutes} min late</span>`
      : `<span style="color:#34d399;">On Time</span>`;

    const activeMarker = L.marker([currentTrainLat, currentTrainLng], { icon: trainPulseIcon });
    activeMarker.bindPopup(`
      <div class="train-popup-card">
        <div class="popup-train-num">🚄 #${liveData.trainNumber}</div>
        <div class="popup-train-name">${liveData.trainName}</div>
        <div style="font-size: 0.75rem; font-weight: 700;">
          ${currentLoc.stationName ? 'At ' + currentLoc.stationName : 'En Route'}
          · ${delayStr}
        </div>
        <div style="font-size: 0.7rem; color: #94a3b8; margin-top: 2px;">
          ${trainDistKm ? trainDistKm + ' km from origin' : ''}
        </div>
      </div>
    `);

    activeStationsLayer.addLayer(activeMarker);
  }
}

// ================================================================
//  POLYLINE INTERPOLATION — find [lat,lng] at a given km distance
// ================================================================

/**
 * Given a polyline (array of [lat,lng] pairs) and a target distance in km,
 * return the interpolated [lat,lng] position on that polyline.
 *
 * @param {Array} polyline - Array of [lat, lng] coordinate pairs
 * @param {number} targetKm - Distance from the start in km
 * @param {number} totalRouteKm - Total route distance in km (from station data)
 * @returns {[number,number]|null} - [lat, lng] or null
 */
function interpolateOnPolyline(polyline, targetKm, totalRouteKm) {
  if (!polyline || polyline.length < 2 || targetKm == null) return null;

  // Compute cumulative distance along polyline
  const cumDist = [0]; // km
  for (let i = 1; i < polyline.length; i++) {
    const d = haversineKm(polyline[i - 1], polyline[i]);
    cumDist.push(cumDist[i - 1] + d);
  }
  const polylineTotalKm = cumDist[cumDist.length - 1];

  // Scale targetKm from route-km to polyline-km (they may differ slightly)
  const scale = totalRouteKm > 0 ? polylineTotalKm / totalRouteKm : 1;
  const targetPolyKm = targetKm * scale;

  // Clamp
  if (targetPolyKm <= 0) return polyline[0];
  if (targetPolyKm >= polylineTotalKm) return polyline[polyline.length - 1];

  // Binary search for the segment containing targetPolyKm
  let lo = 0, hi = cumDist.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cumDist[mid] <= targetPolyKm) lo = mid;
    else hi = mid;
  }

  // Linear interpolation within the segment [lo, hi]
  const segLen = cumDist[hi] - cumDist[lo];
  const t = segLen > 0 ? (targetPolyKm - cumDist[lo]) / segLen : 0;
  const lat = polyline[lo][0] + t * (polyline[hi][0] - polyline[lo][0]);
  const lng = polyline[lo][1] + t * (polyline[hi][1] - polyline[lo][1]);

  return [lat, lng];
}

/** Haversine distance between two [lat,lng] points, in km */
function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b[0] - a[0]) * Math.PI / 180;
  const dLng = (b[1] - a[1]) * Math.PI / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat +
    Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) *
    sinLng * sinLng;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// Render Train Drawer Details
function renderTrainDrawer(liveData, coachesData) {
  const drawer = document.getElementById('trainDrawer');
  const trainInfo = liveData.train || {};
  const currentLoc = liveData.currentLocation || {};
  const prevHalt = liveData.previousHalt || {};
  const nextHalt = liveData.nextHalt || {};
  const route = liveData.route || [];

  document.getElementById('drawerTrainNum').innerText = `#${liveData.trainNumber}`;
  document.getElementById('drawerTrainType').innerText = trainInfo.type || 'Superfast Express';
  document.getElementById('drawerTrainName').innerText = liveData.trainName || trainInfo.name || 'Express Train';

  // Route Source & Destination
  document.getElementById('drawerSourceCode').innerText = trainInfo.source?.code || 'ORIGIN';
  document.getElementById('drawerSourceName').innerText = trainInfo.source?.name || '';
  document.getElementById('drawerDestCode').innerText = trainInfo.destination?.code || 'DEST';
  document.getElementById('drawerDestName').innerText = trainInfo.destination?.name || '';

  // Delay & Status
  const delayMinutes = liveData.delayMinutes ?? 0;
  const delayBadge = document.getElementById('drawerDelayBadge');
  if (delayMinutes <= 0) {
    delayBadge.className = 'delay-badge-pill ontime';
    delayBadge.innerHTML = '🟢 On Time';
  } else if (delayMinutes < 30) {
    delayBadge.className = 'delay-badge-pill delayed';
    delayBadge.innerHTML = `🟡 Delayed by ${delayMinutes} mins`;
  } else {
    delayBadge.className = 'delay-badge-pill late';
    delayBadge.innerHTML = `🔴 Delayed by ${delayMinutes} mins`;
  }

  // 🚇 Tunnel tracking + GPS blind-spot panel
  renderTunnelPanel(liveData);

  // 🔀 Crossing / overtake loop-hold prediction
  renderConflictPanel(liveData);

  // Current Position
  const posText = currentLoc.stationName
    ? `${currentLoc.status === 'departed' ? 'Departed from' : 'Approaching'} ${currentLoc.stationName}`
    : (liveData.status === 'running' ? 'En Route' : 'Scheduled');
  document.getElementById('drawerCurrentPos').innerText = posText;

  // Next Halt
  if (nextHalt.stationName) {
    document.getElementById('drawerNextHalt').innerText = `Next halt: ${nextHalt.stationName} (Seq ${nextHalt.sequence || ''})`;
  } else {
    document.getElementById('drawerNextHalt').innerText = `Destination: ${trainInfo.destination?.name || 'End of journey'}`;
  }

  // Progress Bar calculation
  const totalDist = trainInfo.distance || 1000;
  const coveredDist = currentLoc.distanceFromOriginKm || (route.find(s => s.sequence === currentLoc.sequence)?.distance) || 0;
  const pct = Math.min(100, Math.max(0, Math.round((coveredDist / totalDist) * 100)));
  
  document.getElementById('drawerProgressFill').style.width = `${pct || 15}%`;
  document.getElementById('drawerCoveredKm').innerText = `${coveredDist} km covered (${pct}%)`;
  document.getElementById('drawerTotalKm').innerText = `${totalDist} km total`;

  // Render Coach Composition
  renderCoaches(coachesData || trainInfo.coachPosition);

  // Render Halts Timeline
  renderTimeline(route, currentLoc);

  drawer.classList.add('open');
}

// Render Coach Boxes
function renderCoaches(coachesData) {
  const container = document.getElementById('coachRakeContainer');
  container.innerHTML = '';

  let coachList = [];
  if (coachesData && coachesData.coaches && Array.isArray(coachesData.coaches)) {
    coachList = coachesData.coaches.map(c => ({ code: c.code, class: c.classType || c.category }));
  } else if (typeof coachesData === 'string') {
    coachList = coachesData.split('-').map(code => ({ code, class: code.slice(0, 2) }));
  }

  if (coachList.length === 0) {
    coachList = ['ENG', 'GEN', 'S1', 'S2', 'B1', 'B2', 'A1', 'SLRD'].map(code => ({ code, class: code }));
  }

  coachList.forEach((c) => {
    const box = document.createElement('div');
    const code = c.code.toUpperCase();
    let cls = 'ac';
    if (code.includes('ENG') || code.includes('LOCO')) cls = 'eng';
    else if (code.includes('EC') || code.includes('EA')) cls = 'ec';
    else if (code.includes('CC') || code.includes('C')) cls = 'cc';
    else if (code.includes('S') || code.includes('SL')) cls = 'sl';
    else if (code.includes('GEN') || code.includes('UR') || code.includes('GS')) cls = 'gen';

    box.className = `coach-box ${cls}`;
    box.innerText = code;
    box.title = `Coach ${code}`;
    container.appendChild(box);
  });
}

// Render Journey Timeline Halts
function renderTimeline(route, currentLoc) {
  const list = document.getElementById('timelineHaltsList');
  list.innerHTML = '';

  const halts = route.filter(s => s.isHalt);
  const displayList = halts.length > 0 ? halts : route.slice(0, 30);

  displayList.forEach((s) => {
    const isPassed = s.status === 'departed' || s.status === 'arrived';
    const isCurrent = s.sequence === currentLoc.sequence;

    const item = document.createElement('div');
    item.className = `timeline-item ${isPassed ? 'passed' : ''} ${isCurrent ? 'current' : ''}`;

    const scheduledTime = s.scheduledArrival || s.scheduledDeparture || '--:--';
    const timeStr = scheduledTime.includes('T') ? scheduledTime.split('T')[1].slice(0, 5) : scheduledTime;

    const delay = s.delayDeparture ?? s.delayArrival ?? 0;
    
    // Calculate expected time based on delay
    let expectedTimeHtml = '';
    if (delay > 0 && scheduledTime !== '--:--') {
      try {
        let date;
        if (scheduledTime.includes('T')) {
          date = new Date(scheduledTime);
        } else {
          const [hh, mm] = scheduledTime.split(':').map(Number);
          date = new Date();
          date.setHours(hh, mm, 0, 0);
        }
        if (!isNaN(date.getTime())) {
          date.setMinutes(date.getMinutes() + delay);
          const expH = String(date.getHours()).padStart(2, '0');
          const expM = String(date.getMinutes()).padStart(2, '0');
          expectedTimeHtml = `<div class="time-expected" style="color: #fbbf24; font-weight: 700; font-size: 0.85rem;">${expH}:${expM}</div>`;
        }
      } catch (e) {
        console.error('Failed to parse expected time:', e);
      }
    }

    const scheduledDisplayHtml = delay > 0 
      ? `<div class="time-scheduled-crossed" style="font-size: 0.72rem; color: var(--text-dim); text-decoration: line-through;">${timeStr}</div>`
      : `<div class="time-scheduled" style="font-weight: 700; font-size: 0.85rem; color: var(--text-main);">${timeStr}</div>`;

    const delayHtml = delay > 0 
      ? `<div class="time-delay-tag" style="color: #fbbf24; font-size: 0.7rem; font-weight: 600;">+${delay}m</div>` 
      : `<div class="time-ontime-tag" style="color: #34d399; font-size: 0.7rem;">On Time</div>`;

    item.innerHTML = `
      <div class="timeline-dot"></div>
      <div>
        <div class="station-title">${s.stationName || s.stationCode}</div>
        <div class="station-meta-sub">Platform ${s.platform || '1'} &bull; ${s.distance || 0} km</div>
      </div>
      <div class="station-time-col" style="text-align: right; display: flex; flex-direction: column; justify-content: center; align-items: flex-end;">
        ${scheduledDisplayHtml}
        ${expectedTimeHtml}
        ${delayHtml}
      </div>
    `;

    list.appendChild(item);
  });
}

function openDrawerLoading(num) {
  const drawer = document.getElementById('trainDrawer');
  
  // Reset texts
  document.getElementById('drawerTrainNum').innerText = `#${num}`;
  document.getElementById('drawerTrainType').innerText = 'Locating...';
  document.getElementById('drawerTrainName').innerText = 'Loading train telemetry...';
  
  document.getElementById('drawerSourceCode').innerText = '-';
  document.getElementById('drawerSourceName').innerText = 'Loading Origin';
  document.getElementById('drawerDestCode').innerText = '-';
  document.getElementById('drawerDestName').innerText = 'Loading Destination';
  
  document.getElementById('drawerCurrentPos').innerText = 'Querying live position...';
  document.getElementById('drawerNextHalt').innerText = 'Retrieving schedule...';
  
  // Reset badges and panels
  const delayBadge = document.getElementById('drawerDelayBadge');
  delayBadge.className = 'delay-badge-pill ontime';
  delayBadge.innerHTML = '⚡ Checking...';
  
  document.getElementById('drawerDrBadge').style.display = 'none';
  document.getElementById('tunnelPanel').style.display = 'none';
  document.getElementById('deadReckoningPanel').style.display = 'none';
  document.getElementById('conflictPanel').style.display = 'none';
  document.getElementById('conflictUnavailable').style.display = 'none';
  
  // Reset progress bar
  document.getElementById('drawerProgressFill').style.width = '0%';
  document.getElementById('drawerCoveredKm').innerText = '-';
  document.getElementById('drawerTotalKm').innerText = '-';
  
  // Clear lists
  document.getElementById('coachRakeContainer').innerHTML = '<div style="color:var(--text-dim);font-size:0.75rem;">Loading coach composition...</div>';
  document.getElementById('timelineHaltsList').innerHTML = '<div style="color:var(--text-dim);font-size:0.75rem;padding:12px;">Loading route stops...</div>';
  
  drawer.classList.add('open');
}

function closeDrawer() {
  document.getElementById('trainDrawer').classList.remove('open');
}

// Setup Search Autocomplete with Client-Side Caching
function setupSearch() {
  const input = document.getElementById('searchInput');
  const dropdown = document.getElementById('searchDropdown');

  input.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    if (val.length < 2) {
      dropdown.classList.remove('active');
      return;
    }

    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(async () => {
      // Check client cache first
      if (clientCache.searches.has(val)) {
        renderSearchResults(clientCache.searches.get(val));
        return;
      }

      try {
        const res = await fetch(apiUrl(`/api/trains/search?q=${encodeURIComponent(val)}`));
        const json = await res.json();
        const results = json.data?.data || json.data || [];
        clientCache.searches.set(val, results);
        renderSearchResults(results);
      } catch (err) {
        console.error('Search failed:', err);
      }
    }, 280);
  });

  input.addEventListener('focus', () => {
    if (input.value.trim().length >= 2) {
      dropdown.classList.add('active');
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.top-search-container')) {
      dropdown.classList.remove('active');
    }
  });
}

function renderSearchResults(trains) {
  const dropdown = document.getElementById('searchDropdown');
  dropdown.innerHTML = '';

  if (!trains || trains.length === 0) {
    dropdown.innerHTML = '<div style="padding: 12px; color: #94a3b8; font-size: 0.85rem; text-align: center;">No trains found matching query</div>';
    dropdown.classList.add('active');
    return;
  }

  const title = document.createElement('div');
  title.className = 'dropdown-section-title';
  title.innerText = 'Trains & Routes';
  dropdown.appendChild(title);

  trains.slice(0, 8).forEach((t) => {
    const item = document.createElement('div');
    item.className = 'search-item';
    item.innerHTML = `
      <div class="search-item-left">
        <div class="train-pill">${t.number}</div>
        <div class="search-item-info">
          <span class="search-item-title">${t.name}</span>
          <span class="search-item-route">${t.sourceName || t.source || ''} &rarr; ${t.destName || t.dest || ''}</span>
        </div>
      </div>
      <div class="search-type-badge">${t.type || 'Express'}</div>
    `;

    item.addEventListener('click', () => {
      document.getElementById('searchInput').value = `${t.number} - ${t.name}`;
      dropdown.classList.remove('active');
      selectTrain(t.number);
    });

    dropdown.appendChild(item);
  });

  dropdown.classList.add('active');
}

// Setup Event Listeners
function setupEventListeners() {
  document.getElementById('layerToggleBtn').addEventListener('click', toggleMapLayer);

  document.getElementById('zoomInBtn').addEventListener('click', () => {
    map.zoomIn();
  });

  document.getElementById('zoomOutBtn').addEventListener('click', () => {
    map.zoomOut();
  });

  document.getElementById('recenterBtn').addEventListener('click', () => {
    map.flyTo([16.8, 73.5], 7, { duration: 1 });
  });

  document.getElementById('fullscreenBtn').addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });

  document.getElementById('drawerCloseBtn').addEventListener('click', () => {
    closeDrawer();
    stopTrainAutoRefresh();
  });
}

// ================================================================
//  LIVE AUTO-REFRESH SYSTEM
// ================================================================

/**
 * Start the fleet radar auto-refresh. Fires every CACHE_TTL.fleet (60s). The server no longer
 * caches live data, so each tick is one real RailRadar call per configured train — the poll
 * interval is the quota spend. Bursts are prevented upstream-side by the global scheduler in
 * src/services/railradar.js, not by a cache.
 */
function startAutoRefresh() {
  if (fleetRefreshInterval) clearInterval(fleetRefreshInterval);
  fleetRefreshInterval = setInterval(() => {
    // A hidden tab must not spend quota. A forgotten background tab polling all night is the
    // single most likely way the monthly budget dies, so skip the tick instead of firing it.
    if (document.visibilityState === 'hidden') return;
    console.log('[Live] Auto-refreshing fleet radar (live upstream)...');
    loadLiveFleet(true);          // bypass client cache; server has no live cache to respect
  }, CACHE_TTL.fleet);
}

/**
 * Start auto-refreshing the selected train. Fires every CACHE_TTL.trainLive (30s) and each tick
 * is a real upstream call — there is no server-side live cache shielding it any more.
 */
function startTrainAutoRefresh(trainNumber) {
  stopTrainAutoRefresh();
  trainRefreshInterval = setInterval(() => {
    if (document.visibilityState === 'hidden') return;   // see note in startAutoRefresh
    if (selectedTrainNumber === trainNumber) {
      console.log(`[Live] Auto-refreshing train #${trainNumber} (live upstream)...`);
      selectTrain(trainNumber, true);   // bypass client cache; no server live cache to respect
    } else {
      stopTrainAutoRefresh();
    }
  }, CACHE_TTL.trainLive);
}

/** Stop the train auto-refresh */
function stopTrainAutoRefresh() {
  if (trainRefreshInterval) {
    clearInterval(trainRefreshInterval);
    trainRefreshInterval = null;
  }
}

// ================================================================
//  LIVE CLOCK & STATUS PILL
// ================================================================

/** Tick the fleet status pill with a live clock and time-ago */
function startLiveClock() {
  if (clockInterval) clearInterval(clockInterval);
  clockInterval = setInterval(() => {
    updateFleetPill();
  }, 1000);
}

function updateFleetPill(trainCount) {
  const fleetPill = document.getElementById('fleetStatusText');
  if (!fleetPill) return;

  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

  const count = trainCount ?? clientCache.fleet?.length ?? 0;

  if (lastFleetUpdateTime) {
    const agoSec = Math.round((Date.now() - lastFleetUpdateTime) / 1000);
    const agoStr = agoSec < 60 ? `${agoSec}s ago` : `${Math.floor(agoSec / 60)}m ago`;
    fleetPill.innerText = `${count} Konkan Trains · ${timeStr} · Updated ${agoStr}`;
  } else if (count > 0) {
    fleetPill.innerText = `${count} Konkan Trains Live · ${timeStr}`;
  } else {
    fleetPill.innerText = `Connecting · ${timeStr}`;
  }
}

// ================================================================
//  VISUAL FEEDBACK
// ================================================================

/** Flash an element to indicate data just updated */
function flashElement(el) {
  if (!el) return;
  el.classList.add('data-flash');
  setTimeout(() => el.classList.remove('data-flash'), 800);
}
