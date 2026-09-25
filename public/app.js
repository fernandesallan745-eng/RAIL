// RailRadar Live Map Engine
const clientCache = {
  fleet: null,
  fleetTime: 0,
  trainLive: new Map(),
  trainLiveTime: new Map(),      // timestamp per train for TTL
  trainRoute: new Map(),
  trainCoaches: new Map(),
  searches: new Map(),
  runState: new Map(),           // train number → run-state block (model API)
  lastGoodConflicts: new Map(),  // train number → last valid crossing prediction (prevents UI flicker on timeout)
  lastGoodCurvatureEta: new Map(), // train number → last valid curvature ETA
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
let corridorConflictLayer = null;
let activeTrainMarker = null;

// Corridor-wide scheduled-crossing layer state. Off by default; fetched lazily
// the first time it is switched on, then cached client-side for the session so a
// re-toggle is instant and never re-hits the gateway. Every meet here is two
// SCHEDULED timetables crossing — no live GPS (VERIFIED #12/#21) — which is why
// it is a separate layer from the live-fleet conflictLayer, not folded into it.
let corridorLayerOn = false;
let corridorData = null;

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

  // Signal that the map and every layer group exist. bootstrapApp is async (it awaits
  // loadPackManifest), so a second script loaded alongside this one would find `map`
  // still null if it ran on DOMContentLoaded — admin.js listens for this instead of
  // racing or polling. Harmless on the user page, which has no listener.
  document.dispatchEvent(new CustomEvent('gati:ready'));
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
  // Corridor-wide scheduled crossings. Created but deliberately NOT added to the
  // map: this layer is opt-in (see toggleCorridorLayer). Building the group up
  // front means the toggle never has to null-check it.
  corridorConflictLayer = L.layerGroup();
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

    // Status line. "On Time" is a claim about a train that is MOVING — a train
    // that has not departed, is not running today, or has finished cannot be on
    // time, and rendering it green made a static marker look tracked. Run-state
    // is resolved server-side (train.controller.js attachFleetRunStates) so the
    // popup, the drawer and /admin cannot disagree.
    const rsState = train.runState?.state || null;
    const statusText = {
      'awaiting-departure': '<span style="color: #38bdf8;">Not yet departed</span>',
      'not-running-today': '<span style="color: #fbbf24;">Not running today</span>',
      'scheduled-today': '<span style="color: #38bdf8;">Scheduled, not tracking</span>',
      completed: '<span style="color: #34d399;">Journey completed</span>',
      unknown: '<span style="color: #94a3b8;">State unknown</span>',
    }[rsState] || (train.delayMinutes > 0
      ? `<span style="color: #fbbf24;">+${train.delayMinutes} min</span>`
      : '<span style="color: #34d399;">On Time</span>');

    // Speed representation: if dynamic GPS velocity is available and live, show live GPS velocity;
    // otherwise show scheduled block speed with clear honesty.
    const speedText = Number.isFinite(Number(train.speed))
      ? `${Math.round(Number(train.speed))} km/h`
      : '—';
    const hasLiveVel = Boolean(train.liveVelocity?.isLive);
    const speedHtml = hasLiveVel
      ? `<span title="${escapeHtml(train.liveVelocity.basisLabel || 'Live GPS delta')}"><strong style="color: #38bdf8;">⚡ ${train.liveVelocity.liveSpeedKmph} km/h</strong> (${escapeHtml(train.liveVelocity.phase)})</span>`
      : `<span title="Schedule-derived block speed (speedToNextStationKmph) — not a live GPS reading">Speed (sched): ${speedText}</span>`;
    const nextRun = rsState === 'not-running-today' && train.runState?.nextRunDate
      ? `<div style="font-size: 0.7rem; color: #fbbf24; margin-top: 3px;">Next service: ${train.runState.nextRunDate}</div>`
      : '';

    marker.bindPopup(`
      <div class="train-popup-card">
        <div class="popup-train-num">#${train.number}${train.type ? ` &bull; ${train.type}` : ''}</div>
        <div class="popup-train-name">${train.name}</div>
        <div class="popup-stats-row">
          ${speedHtml}
          <span>Status: ${statusText}</span>
        </div>
        ${nextRun}
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
      // `hazards=true` asks the model to fold CONFIRMED crowdsourced hazards into
      // the ETA. Sent on every drawer fetch, not only on open: if it were sent on
      // open and dropped by the 20 s poll, the hazard panel would appear and then
      // silently vanish 20 s later, which reads as a failure rather than as a
      // policy. Costs no upstream RailRadar request — the model is cache-only —
      // and the default `/eta` path is unchanged for everyone who does not ask.
      const url = apiUrl(`/api/trains/${trainNumber}/live?geometry=true&geometry_format=geojson&hazards=true${forceServerRefresh ? '&refresh=true' : ''}`);
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
      // Continuity guard: if auto-refresh hit a momentary model timeout, retain last known good model results
      if (liveData.conflicts) {
        clientCache.lastGoodConflicts.set(trainNumber, liveData.conflicts);
      } else if (liveData.conflictsUnavailable?.reason === 'model-unreachable' && clientCache.lastGoodConflicts.has(trainNumber)) {
        liveData.conflicts = clientCache.lastGoodConflicts.get(trainNumber);
        liveData.conflictsTransient = true;
      }

      if (liveData.curvatureEta) {
        clientCache.lastGoodCurvatureEta.set(trainNumber, liveData.curvatureEta);
      } else if (liveData.curvatureEtaUnavailable?.reason === 'model-unreachable' && clientCache.lastGoodCurvatureEta.has(trainNumber)) {
        liveData.curvatureEta = clientCache.lastGoodCurvatureEta.get(trainNumber);
        liveData.curvatureEtaTransient = true;
      }

      renderTrainOnMap(liveData, routeGeoJson, forceRefresh);
      renderTrainDrawer(liveData, coachesData);
      if (forceRefresh) {
        flashElement(document.getElementById('trainDrawer'));
      }
    }
  } catch (err) {
    console.error('Failed to load train details:', err);
    stopTrainAutoRefresh();
    showDrawerError(trainNumber, err);
  }
}

// In-drawer error state, replacing a blocking alert().
//
// The alert() this replaces was modal — it stole focus, had to be dismissed
// before the map could be touched again, and fired on the 20 s auto-refresh path
// too, so a single upstream hiccup could interrupt the demo repeatedly. It also
// said the same thing for every failure.
//
// The three failures are genuinely different and the gateway already classifies
// them, so they are named rather than flattened — the same discipline as
// showCorridorUnavailable() and sendModelError().
function showDrawerError(trainNumber, err) {
  const msg = String(err && err.message ? err.message : err);
  const is429 = /429|rate.?limit|quota/i.test(msg);
  const is404 = /404|not found|no cached|not-cached/i.test(msg);
  const isDown = /failed to fetch|networkerror|econnrefused|model-unreachable/i.test(msg);

  const { head, body } = is429
    ? {
      head: '⏳ Upstream rate limit reached',
      body: 'RailRadar is throttling us right now. The limit is per minute, so this '
          + 'usually clears in under a minute — the map keeps showing the last known '
          + 'positions meanwhile.',
    }
    : is404
      ? {
        head: '🔍 No live data for this train',
        body: `RailRadar has no running-status record for #${trainNumber} today. It may not `
            + 'be a tracked service, or it may not run on this date.',
      }
      : isDown
        ? {
          head: '🔌 Cannot reach the GATI gateway',
          body: 'The tracker server is not responding. If you are running it locally, check '
              + 'that <code>npm run dev</code> is still up.',
        }
        : { head: '⚠️ Could not load live details', body: msg };

  const name = document.getElementById('drawerTrainName');
  if (name) name.innerHTML = `<span style="color: #f87171; font-weight: 700; font-size: 0.85rem;">${head}</span>`;

  // Reuse the run-state panel as the error surface: it sits at the top of the
  // card and is already the element that explains "why is there nothing here".
  const panel = document.getElementById('runStatePanel');
  const header = document.getElementById('runStateHeader');
  const rsBody = document.getElementById('runStateBody');
  if (panel && header && rsBody) {
    panel.style.display = 'block';
    panel.style.background = 'rgba(248, 113, 113, 0.08)';
    panel.style.border = '1px solid rgba(248, 113, 113, 0.3)';
    header.innerHTML = `<span style="color:#f87171;">${head}</span>`;
    rsBody.innerHTML = `${body}<br/><button type="button" id="drawerRetryBtn" `
      + 'style="margin-top:8px;padding:5px 12px;border-radius:6px;cursor:pointer;'
      + 'background:rgba(248,113,113,0.15);border:1px solid rgba(248,113,113,0.4);'
      + 'color:#fca5a5;font-size:0.72rem;font-weight:600;">Retry</button>';
    const retry = document.getElementById('drawerRetryBtn');
    if (retry) retry.addEventListener('click', () => selectTrain(trainNumber, false, false));
  }

  // Nothing below the error is meaningful for a train we failed to load.
  const hide = (id) => { const el = document.getElementById(id); if (el) el.style.display = 'none'; };
  hide('progressBlock');
  hide('tunnelPanel');
  hide('conflictPanel');
  hide('conflictUnavailable');
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
    // Draw anything that HAS coordinates, whichever basis supplied them: the
    // train's own station rows ('interpolated') or the shared Konkan alignment
    // ('shared-corridor-polyline'). Testing for one basis name by hand would
    // silently drop every roster train — they carry no station coordinates at
    // all, so the shared polyline is the only thing that can place them. The
    // panel still lists unmappable meets and coordsNote says how many, so a
    // missing marker is never an unexplained absence.
    if (c.meetLat == null || c.meetLng == null) continue;

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

// ── Corridor-wide scheduled crossings (all trains, opt-in layer) ─────────────
// Toggled by the ⇄ control. First activation fetches the whole-corridor sweep
// for today's service date from the gateway, which costs ZERO upstream RailRadar
// requests — every meet falls out of two cached timetables (VERIFIED #15). The
// result is cached for the session; a re-toggle just re-adds the built markers.
async function toggleCorridorLayer() {
  const btn = document.getElementById('corridorToggleBtn');
  const legend = document.getElementById('corridorLegend');

  if (corridorLayerOn) {
    // Hide, but keep the built markers and the cached data — cheap to re-show.
    map.removeLayer(corridorConflictLayer);
    corridorLayerOn = false;
    if (btn) btn.setAttribute('aria-pressed', 'false');
    if (legend) legend.hidden = true;
    return;
  }

  // Fetch once; reuse thereafter.
  if (!corridorData) {
    if (btn) btn.classList.add('is-busy');
    try {
      const res = await fetch(apiUrl('/api/corridor/conflicts'));
      const json = await res.json();
      if (!json.success || !json.data) {
        // A failure must be visible, not a silently empty layer: "no meets"
        // and "the sweep did not run" look identical on a map (VERIFIED #9).
        showCorridorUnavailable(json.reason, json.hint || json.detail);
        return;
      }
      corridorData = json.data;
      renderCorridorConflicts(corridorData);
    } catch (err) {
      console.error('Corridor sweep fetch failed:', err);
      showCorridorUnavailable('model-unreachable',
        'start the ETA model: python3 run_server.py 8000');
      return;
    } finally {
      if (btn) btn.classList.remove('is-busy');
    }
  }

  corridorConflictLayer.addTo(map);
  corridorLayerOn = true;
  if (btn) btn.setAttribute('aria-pressed', 'true');
  if (legend) legend.hidden = false;
}

function showCorridorUnavailable(reason, hint) {
  const legend = document.getElementById('corridorLegend');
  const count = document.getElementById('corridorLegendCount');
  const note = document.getElementById('corridorLegendNote');
  const btn = document.getElementById('corridorToggleBtn');
  if (!legend) return;
  legend.hidden = false;
  if (btn) btn.setAttribute('aria-pressed', 'false');
  if (count) count.textContent = 'Corridor crossings unavailable';
  if (note) {
    note.textContent =
      reason === 'model-unreachable'
        ? `The conflict model is not reachable, so the corridor sweep could not run. ${hint || ''}`.trim()
        : `The corridor sweep could not run (${reason || 'unknown reason'}). ${hint || ''}`.trim();
  }
}

// Draw every deduplicated corridor meet. Amber = head-on, violet = overtake —
// deliberately DIFFERENT hues from the live per-train layer's red/green, because
// these are scheduled meets, not the tracked fleet train's live crossings.
function renderCorridorConflicts(data) {
  if (!corridorConflictLayer) return;
  corridorConflictLayer.clearLayers();

  const meets = Array.isArray(data.meets) ? data.meets : [];
  let drawn = 0;
  for (const m of meets) {
    if (m.lat == null || m.lng == null) continue;   // undrawable; counted below
    const overtake = m.kind === 'overtake';
    const colour = overtake ? '#a78bfa' : '#f59e0b';

    const marker = L.circleMarker([m.lat, m.lng], {
      radius: 3.5,
      color: 'rgba(15,23,42,0.9)',
      weight: 1,
      fillColor: colour,
      fillOpacity: 0.85,
    });

    const heldLine = m.heldTrain
      ? `<div style="font-size:0.72rem;margin-top:4px;color:#b45309">` +
        `#${escapeHtml(m.heldTrain)} takes the loop ~${m.holdMin} min` +
        `${m.holdStation ? ` at ${escapeHtml(m.holdStation)}` : ''}</div>`
      : '';
    const km = m.corridorKm != null ? m.corridorKm.toFixed(1)
      : (m.km != null ? m.km.toFixed(1) : '?');

    marker.bindPopup(
      `<div style="font-family:system-ui,sans-serif;min-width:210px">
         <div style="font-weight:700;font-size:0.88rem">${overtake ? 'Overtake' : 'Head-on crossing'} · km ${km}</div>
         <div style="color:#64748b;font-size:0.72rem;margin-bottom:6px">${escapeHtml(m.betweenFrom || '?')}–${escapeHtml(m.betweenTo || '?')} · ~${escapeHtml(m.clock || '')}</div>
         <div style="font-size:0.78rem"><strong>#${escapeHtml(m.trainA)}</strong> ${escapeHtml(m.trainAName || '')}</div>
         <div style="font-size:0.78rem">vs <strong>#${escapeHtml(m.trainB)}</strong> ${escapeHtml(m.trainBName || '')}</div>
         ${heldLine}
         <div style="font-size:0.66rem;color:#94a3b8;margin-top:6px;font-style:italic">Scheduled meet — no live position. Loop location assumed; decision support only.</div>
       </div>`
    );
    corridorConflictLayer.addLayer(marker);
    drawn++;
  }

  // The legend headline and note are driven off the PAYLOAD's own counts and
  // honesty text, never restated in prose here, so the UI cannot drift from the
  // model's flags. positionNote already says "no live GPS position".
  const count = document.getElementById('corridorLegendCount');
  const note = document.getElementById('corridorLegendNote');
  if (count) {
    const dateStr = data.serviceDate || 'all dates';
    count.textContent = `${drawn} crossings · ${data.trainsSwept ?? '?'} trains · ${dateStr}`;
  }
  if (note) {
    const undrawable = meets.length - drawn;
    const extra = undrawable > 0
      ? ` ${undrawable} meet${undrawable === 1 ? '' : 's'} have no map position and are not shown.`
      : '';
    note.textContent = (data.positionNote ||
      'Every meet is two scheduled timetables crossing, not two tracked trains.') + extra;
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

  const accent = held ? '#f87171' : rows.length ? '#34d399' : '#94a3b8';
  panel.style.background = held
    ? 'rgba(239, 68, 68, 0.08)'
    : rows.length
      ? 'rgba(52, 211, 153, 0.07)'
      : 'rgba(148, 163, 184, 0.06)';
  panel.style.border = `1px solid ${accent}33`;
  header.style.color = accent;

  header.innerHTML = held
    ? `<div style="display:flex; justify-content:space-between; align-items:center; width:100%;">` +
        `<span>🔀 Loop Holds Predicted</span>` +
        `<span style="background:rgba(239,68,68,0.22); color:#fca5a5; font-size:0.72rem; padding:2px 8px; border-radius:12px; font-weight:700;">~${Math.round(total)} min delay</span>` +
      `</div>`
    : rows.length
      ? `<div style="display:flex; justify-content:space-between; align-items:center; width:100%;">` +
          `<span>🔀 Clear Single-Line Corridor</span>` +
          `<span style="background:rgba(52,211,153,0.18); color:#34d399; font-size:0.72rem; padding:2px 8px; border-radius:12px; font-weight:600;">Right of way</span>` +
        `</div>`
      : '🔀 Crossing prediction';

  if (!rows.length) {
    // Zero rows has TWO causes that mean opposite things, and rendering both as
    // "no crossings predicted" is the silent-zero failure of VERIFIED #9:
    //   - a real result: this train genuinely meets nobody on the single line;
    //   - an uncomputable one: it places fewer than two stations on the section,
    //     shares too little of it, or is not a corridor train at all.
    // The model already decides which and says why, so read its own note rather
    // than restating the rule here — a UI-side copy would drift from the model.
    const meta = info._meta || {};
    const reason = meta.crossingsUnavailableReason || null;
    if (reason) {
      header.innerHTML = '🔀 Crossing prediction unavailable';
      body.innerHTML =
        `<div style="color:var(--text-muted); padding:6px 0; line-height:1.5;">` +
          escapeHtml(meta.crossingsUnavailableNote || 'Crossings cannot be computed for this train.') +
          `<div style="color:var(--text-dim); font-size:0.67rem; margin-top:4px;">` +
            `Reason code: <code>${escapeHtml(reason)}</code> — a coverage gap, not an outage. ` +
            `Live position and tunnel tracking above are unaffected.` +
          `</div>` +
        `</div>`;
      return;
    }
    body.innerHTML =
      '<div style="color:var(--text-dim); padding:6px 0;">No crossings or overtakes predicted on the single-line section for this run.</div>';
    return;
  }

  const heldRows = rows.filter(r => r.whoIsHeld === 'us');
  const winRows = rows.filter(r => r.whoIsHeld !== 'us');

  // Executive summary pills
  const cachedDelay = info.delayBasis === 'cached';
  const delayBadgeText = info.delayMinApplied
    ? `+${info.delayMinApplied}m ${cachedDelay ? 'cached' : 'live'} delay`
    : 'On-time timetable';

  let html = `
    <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:6px; margin-bottom:8px;">
      <span style="background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.08); padding:2px 8px; border-radius:10px; font-size:0.68rem; color:#cbd5e1;">
        ${rows.length} meets
      </span>
      <span style="background:${held ? 'rgba(239,68,68,0.18)' : 'rgba(52,211,153,0.15)'}; color:${held ? '#fca5a5' : '#34d399'}; border:1px solid ${held ? 'rgba(239,68,68,0.3)' : 'rgba(52,211,153,0.3)'}; padding:2px 8px; border-radius:10px; font-size:0.68rem; font-weight:600;">
        ${held ? `⚠️ ${held} hold${held > 1 ? 's' : ''}` : '✓ 0 holds'}
      </span>
      <span style="background:rgba(52,211,153,0.12); border:1px solid rgba(52,211,153,0.25); padding:2px 8px; border-radius:10px; font-size:0.68rem; color:#34d399;">
        ✓ ${winRows.length} priority pass${winRows.length === 1 ? '' : 'es'}
      </span>
      <span style="background:rgba(245,158,11,0.12); border:1px solid rgba(245,158,11,0.25); padding:2px 8px; border-radius:10px; font-size:0.68rem; color:#fbbf24;">
        ${delayBadgeText}
      </span>
      ${info.totalCascadingHoldMin > 0 ? `<span style="background:rgba(168,85,247,0.14); border:1px solid rgba(168,85,247,0.3); padding:2px 8px; border-radius:10px; font-size:0.68rem; color:#c084fc; font-weight:600;">↻ +${Math.round(info.totalCascadingHoldMin)}m cascade</span>` : ''}
    </div>
  `;

  // 1. Prominently display the actual holds (the few items the operator/user cares about)
  if (heldRows.length > 0) {
    html += `
      <div style="margin-bottom:8px;">
        <div style="font-size:0.68rem; font-weight:700; color:#fca5a5; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:5px;">
          Stations where train will hold
        </div>
        <div style="display:flex; flex-direction:column; gap:5px;">
    `;

    for (const r of heldRows) {
      const shift =
        r.shiftKm != null && Math.abs(r.shiftKm) >= 0.1
          ? ` <span style="color:#fbbf24; font-size:0.66rem;">(${Math.abs(r.shiftKm).toFixed(1)} km ${r.shiftKm < 0 ? 'earlier' : 'later'})</span>`
          : r.existsOnTime === false
            ? ' <span style="color:#fbbf24; font-size:0.66rem;">(delay-created)</span>'
            : '';

      const station = escapeHtml(r.holdStationName || r.holdStation || 'Loop station');

      html += `
        <div style="background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.25); border-left:3px solid #f87171; border-radius:6px; padding:6px 9px; display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div style="font-weight:700; color:#fff; font-size:0.78rem; display:flex; align-items:center; gap:5px;">
              <span>⏸</span>
              <span>${station}</span>
              <span style="color:#94a3b8; font-weight:normal; font-size:0.7rem;">~${escapeHtml(r.meetClock)}</span>
            </div>
            <div style="color:#cbd5e1; font-size:0.7rem; margin-top:2px;">
              ${r.kind === 'overtake' ? 'Overtake' : 'Crossing'} vs <strong style="color:#fff">#${escapeHtml(r.otherTrain)}</strong>
              <span style="color:#94a3b8;">${escapeHtml(r.otherType)}</span>${shift}
              ${r.otherDelayMin > 0 ? `<span style="color:#fbbf24; font-size:0.64rem;"> (other +${r.otherDelayMin}m late)</span>` : ''}
              ${r.cascadingHoldUpstreamMin > 0 ? `<span style="color:#c084fc; font-size:0.64rem;"> ↻ +${r.cascadingHoldUpstreamMin}m upstream</span>` : ''}
            </div>
          </div>
          <div style="text-align:right; margin-left:8px; flex-shrink:0;">
            <span style="background:rgba(239,68,68,0.25); color:#fca5a5; font-weight:700; font-size:0.74rem; padding:2px 7px; border-radius:4px; white-space:nowrap; border:1px solid rgba(239,68,68,0.3);">
              ~${r.ourHoldMin} min
            </span>
          </div>
        </div>
      `;
    }

    html += `
        </div>
      </div>
    `;
  } else {
    html += `
      <div style="background:rgba(52,211,153,0.1); border:1px solid rgba(52,211,153,0.25); border-radius:6px; padding:7px 10px; color:#34d399; font-size:0.74rem; display:flex; align-items:center; gap:6px; margin-bottom:6px;">
        <span>✓</span>
        <span><strong>Clear priority:</strong> Train has right of way for all scheduled meets. No loop waits predicted.</span>
      </div>
    `;
  }

  // 2. Collapsible accordion for right-of-way passes (keeps the list short and clean)
  if (winRows.length > 0) {
    html += `
      <details style="margin-top:4px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:5px 8px;">
        <summary style="cursor:pointer; color:#34d399; font-weight:600; font-size:0.72rem; display:flex; justify-content:space-between; align-items:center; user-select:none; outline:none;">
          <span>✓ ${winRows.length} Meets with Right-of-Way (No delay)</span>
          <span style="color:#64748b; font-size:0.68rem;">Click to view ▾</span>
        </summary>
        <div style="margin-top:6px; max-height:160px; overflow-y:auto; display:flex; flex-direction:column; gap:4px; padding-right:4px; border-top:1px solid rgba(255,255,255,0.06); padding-top:6px;">
    `;

    for (const r of winRows) {
      const shift =
        r.shiftKm != null && Math.abs(r.shiftKm) >= 0.1
          ? ` (${Math.abs(r.shiftKm).toFixed(1)} km ${r.shiftKm < 0 ? 'earlier' : 'later'})`
          : '';

      html += `
        <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.69rem; color:#94a3b8; padding:2px 0; border-bottom:1px solid rgba(255,255,255,0.03);">
          <span>
            <span style="color:#34d399;">✓</span> ~${escapeHtml(r.meetClock)} ·
            <strong style="color:#e2e8f0;">#${escapeHtml(r.otherTrain)}</strong>
            <span style="color:#64748b;">${escapeHtml(r.otherType)}</span>
          </span>
          <span style="color:#64748b; font-size:0.65rem;">
            km ${r.meetKm.toFixed(1)}${shift}
          </span>
        </div>
      `;
    }

    html += `
        </div>
      </details>
    `;
  }

  // Coordinate coverage note
  if (info.coordsNote) {
    html += `<div style="color:#fbbf24; font-size:0.68rem; margin-top:6px;">⚠ ${escapeHtml(info.coordsNote)}</div>`;
  }

  body.innerHTML = html;
}

// ── GATI Predictive ETA vs ConfirmTkt Static Broadcast Comparison ─────────
function renderGatiEtaComparison(liveData) {
  const panel = document.getElementById('drawerGatiEtaComparison');
  if (!panel) return;

  const eta = liveData.curvatureEta;
  if (!eta || !eta.totals) {
    panel.style.display = 'none';
    return;
  }

  const ntesDelay = liveData.delayMinutes ?? 0;
  const route = liveData.route || [];
  const destHalt = route.filter(s => s.isHalt).pop() || route[route.length - 1] || {};

  // Scheduled arrival at destination
  const schedArr = destHalt.scheduledArrival || destHalt.scheduledDeparture || eta.scheduled_arrival;
  let ntesArrStr = '--:--';
  if (schedArr) {
    try {
      const dt = new Date(schedArr.includes('T') ? schedArr : `1970-01-01T${schedArr}:00`);
      if (!isNaN(dt.getTime())) {
        dt.setMinutes(dt.getMinutes() + ntesDelay);
        ntesArrStr = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
      }
    } catch (e) {
      ntesArrStr = '--:--';
    }
  }

  // GATI arrival at destination
  let gatiArrStr = '--:--';
  if (eta.predicted_arrival) {
    gatiArrStr = eta.predicted_arrival.includes('T') ? eta.predicted_arrival.split('T')[1].slice(0, 5) : eta.predicted_arrival;
  }
  const gatiDelay = Math.round(eta.arrival_delta_min ?? (eta.totals.predicted_eta_min - (eta.totals.scheduled_duration_min || 0)));

  // Populate ConfirmTkt / NTES box
  const ntesTimeEl = document.getElementById('gatiNtesEstTime');
  const ntesDelayEl = document.getElementById('gatiNtesDelay');
  if (ntesTimeEl) ntesTimeEl.innerText = ntesArrStr !== '--:--' ? ntesArrStr : `+${ntesDelay}m`;
  if (ntesDelayEl) ntesDelayEl.innerText = ntesDelay > 0 ? `+${ntesDelay}m flat static` : 'On time static';

  // Populate GATI box
  const predTimeEl = document.getElementById('gatiPredEstTime');
  const predDelayEl = document.getElementById('gatiPredDelay');
  if (predTimeEl) predTimeEl.innerText = gatiArrStr !== '--:--' ? gatiArrStr : `+${gatiDelay}m`;
  const gatiDelayColor = gatiDelay > 30 ? '#f87171' : (gatiDelay > 0 ? '#fbbf24' : '#34d399');
  if (predDelayEl) predDelayEl.innerHTML = `<span style="color:${gatiDelayColor}; font-weight:700;">+${gatiDelay}m predicted</span>`;

  // Divergence pill
  const divPill = document.getElementById('gatiDivergencePill');
  const divergence = gatiDelay - ntesDelay;
  if (divPill) {
    if (divergence !== 0) {
      divPill.style.display = 'inline-block';
      divPill.innerText = divergence > 0 ? `+${divergence}m vs ConfirmTkt` : `${divergence}m vs ConfirmTkt`;
      divPill.title = `GATI forecasts ${Math.abs(divergence)} mins ${divergence > 0 ? 'more' : 'less'} delay than ConfirmTkt by accounting for physics and crossing bottlenecks`;
    } else {
      divPill.style.display = 'none';
    }
  }

  // Layer breakdown bullets
  const breakdownEl = document.getElementById('gatiLayerBreakdown');
  if (breakdownEl) {
    const items = [];

    const conflictHold = eta.totals.conflict_hold_min || 0;
    if (conflictHold > 0) {
      const meetsCount = (eta.conflict_layer?.conflicts || []).filter(c => c.whoIsHeld === 'us').length;
      items.push(`<span style="color:#f59e0b;font-weight:600;">⚠️ +${conflictHold}m loop holds</span> (${meetsCount} single-line crossing${meetsCount > 1 ? 's' : ''})`);
    }

    const histDelay = eta.totals.historical_delay_min || 0;
    if (histDelay > 0) {
      items.push(`<span style="color:#c084fc;">📊 +${histDelay}m historical corridor delay</span>`);
    }

    const curvMin = eta.curvature_layer_contribution_min;
    if (curvMin && curvMin > 0.05) {
      items.push(`<span style="color:#38bdf8;">🔄 +${curvMin.toFixed(1)}m curvature speed restrictions</span>`);
    }

    const wxFactor = eta.totals.weather_factor ?? eta.weather_factor;
    if (wxFactor && wxFactor < 0.99) {
      items.push(`<span style="color:#fbbf24;">🌧️ Weather friction factor: ${(wxFactor * 100).toFixed(0)}%</span>`);
    }

    const slack = eta.totals.schedule_slack_min || 0;
    if (slack > 0) {
      items.push(`<span style="color:#34d399;">⏱️ -${slack}m timetable slack buffer</span>`);
    }

    breakdownEl.innerHTML = `
      <div style="color:var(--text-dim);margin-bottom:3px;font-size:0.67rem;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Why GATI differs from ConfirmTkt:</div>
      <div style="display:flex;flex-direction:column;gap:2px;">
        ${items.length > 0 ? items.map(it => `<div>&bull; ${it}</div>`).join('') : '<div>&bull; Standard schedule & alignment adherence</div>'}
      </div>
    `;
  }

  panel.style.display = 'block';
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

// ── Run-state panel ─────────────────────────────────────────────────────────
// Answers "is this train actually running?" before any number on the card is
// allowed to imply that it is.
//
// This exists because the drawer used to render `distanceFromOriginKm: 0` as
// "0 km covered (0%)" — with the bar painted at a hardcoded 15% — for trains
// that had not departed, or were not running that day at all. A zero that was
// never measured looked identical to a measured zero. That is VERIFIED #9 at
// the UI layer, the same failure the crossings panel had when it rendered
// "no crossings predicted" for trains it could not compute.
//
// Every branch is driven by the SERVER's `liveData.runState` (resolveRunState in
// train.controller.js). The client does no calendar arithmetic of its own —
// identical discipline to the tunnel and conflict layers, so this page, /admin
// and the model can never disagree about whether a train is running.
//
// Returns true when the progress bar should be shown (i.e. there is a real
// distance to report), false when it must be hidden.
function renderRunState(liveData) {
  const panel = document.getElementById('runStatePanel');
  const header = document.getElementById('runStateHeader');
  const body = document.getElementById('runStateBody');
  if (!panel || !header || !body) return true;   // page without the panel

  const rs = liveData.runState;
  if (!rs || !rs.state) {
    // No run-state block at all: an older cached payload or a gateway that
    // predates the layer. Say the state is unverified rather than assuming it
    // is running — but keep the progress bar, since the position data is real.
    panel.style.display = 'block';
    panel.style.background = 'rgba(148, 163, 184, 0.08)';
    panel.style.border = '1px solid rgba(148, 163, 184, 0.25)';
    header.innerHTML = '<span style="color:#94a3b8;">◌ Run state unverified</span>';
    body.innerHTML = 'This response carries no run-state block, so whether the '
      + 'train is running today could not be confirmed.';
    return true;
  }

  const dateStr = (iso) => {
    if (!iso) return null;
    const d = new Date(`${iso}T00:00:00`);
    return Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  };
  // Basis label, always rendered: the same answer means different things
  // depending on whether it came from a live status, upstream's own start date,
  // or the cached roster calendar.
  const basisNote = {
    'live-status': 'from the live status feed',
    'live-start-date': "from upstream's own service date",
    'roster-calendar': 'from the cached roster calendar',
    'roster-calendar-stale-snapshot': 'from the cached roster calendar (the position snapshot is older than today)',
    'no-calendar': 'no run calendar is cached for this train',
    'unresolved': 'neither a live status nor a run calendar was available',
  }[rs.basis] || rs.basis;

  const set = (bg, border, head, text) => {
    panel.style.display = 'block';
    panel.style.background = bg;
    panel.style.border = `1px solid ${border}`;
    header.innerHTML = head;
    body.innerHTML = text;
  };

  switch (rs.state) {
    case 'running':
      // Nothing to warn about: the progress bar is the truthful display here.
      // Clear the text as well as hiding the box: the drawer is reused for every
      // train, so a verdict left in a hidden element belongs to whichever train
      // was open last. Invisible today, wrong the moment anything reveals or
      // reads it — the same stale-derived-value hazard as VERIFIED #21.
      panel.style.display = 'none';
      header.innerHTML = '';
      body.innerHTML = '';
      return true;

    case 'awaiting-departure': {
      const dep = liveData.route && liveData.route[0];
      const depTime = dep && dep.scheduledDeparture
        ? new Date(dep.scheduledDeparture).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : null;
      const from = (dep && dep.stationName) || liveData.train?.source?.name || null;
      set('rgba(56, 189, 248, 0.08)', 'rgba(56, 189, 248, 0.3)',
        '<span style="color:#38bdf8;">◷ NOT YET DEPARTED</span>',
        `Scheduled to run today${depTime ? `, departing <strong>${depTime}</strong>` : ''}`
        + `${from ? ` from ${from}` : ''}. No distance has been covered yet — `
        + `<em>${basisNote}</em>.`);
      return false;   // 0 km is correct but not a measurement; hide the bar
    }

    case 'not-running-today': {
      const next = dateStr(rs.nextRunDate);
      const days = Array.isArray(rs.runDays) && rs.runDays.length
        ? rs.runDays.map((d) => d.charAt(0).toUpperCase() + d.slice(1)).join(', ')
        : null;
      // Flag a source disagreement rather than hiding it behind the winner.
      const disagree = rs.calendarAgrees === false && rs.calendarNextRunDate
        ? `<br/><span style="color:#fbbf24;">⚠ The roster calendar expects the next run on `
          + `${dateStr(rs.calendarNextRunDate)}; upstream says ${next}. Showing upstream's date.</span>`
        : '';
      set('rgba(251, 191, 36, 0.08)', 'rgba(251, 191, 36, 0.35)',
        '<span style="color:#fbbf24;">⏸ NOT RUNNING TODAY</span>',
        `This train does not run on ${dateStr(rs.serviceDate) || 'this date'}.`
        + `${days ? ` It runs on <strong>${days}</strong>.` : ''}`
        + `${next ? ` Next service <strong>${next}</strong>.` : ''}`
        + ` Live tracking will be available once it departs — <em>${basisNote}</em>.${disagree}`);
      return false;
    }

    case 'completed': {
      const last = (liveData.route && liveData.route[liveData.route.length - 1]) || null;
      const arr = last && (last.actualArrival || last.scheduledArrival)
        ? new Date(last.actualArrival || last.scheduledArrival)
          .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : null;
      set('rgba(52, 211, 153, 0.08)', 'rgba(52, 211, 153, 0.3)',
        '<span style="color:#34d399;">✓ JOURNEY COMPLETED</span>',
        `This run has finished${arr ? `, arriving <strong>${arr}</strong>` : ''}`
        + `${last && last.stationName ? ` at ${last.stationName}` : ''}. `
        + `The position shown is its last reported one — <em>${basisNote}</em>.`);
      return true;   // the full journey distance IS a real measurement
    }

    case 'scheduled-today':
      set('rgba(56, 189, 248, 0.08)', 'rgba(56, 189, 248, 0.3)',
        '<span style="color:#38bdf8;">◷ SCHEDULED TODAY</span>',
        `Runs today per the roster calendar, but no live status is available for `
        + `it, so its current position is unknown — <em>${basisNote}</em>.`);
      return false;

    default: {
      // 'unknown'. Deliberately NOT rendered as "not running": unknown and
      // "does not run" are different answers and collapsing them would put a
      // confident wrong statement on screen.
      //
      // The server's own note and the basis label often say the same thing
      // ("No calendar cached." / "no run calendar is cached for this train"),
      // so they are joined with an em-dash rather than concatenated into two
      // sentences where the second starts lowercase.
      const why = rs.note && rs.note.trim()
        ? `${rs.note.trim().replace(/[.\s]+$/, '')} — <em>${basisNote}</em>.`
        : `Whether this train runs today could not be determined — <em>${basisNote}</em>.`;
      set('rgba(148, 163, 184, 0.08)', 'rgba(148, 163, 184, 0.25)',
        '<span style="color:#94a3b8;">◌ RUN STATE UNKNOWN</span>',
        `${why} This is not the same as &ldquo;not running&rdquo; — it means the `
        + `question could not be answered.`);
      return true;
    }
  }
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
  // No invented train class. 'Superfast Express' used to be the fallback here,
  // which put a specific, checkable claim on screen for a train whose type we
  // did not have.
  document.getElementById('drawerTrainType').innerText = trainInfo.type || '—';
  document.getElementById('drawerTrainName').innerText = liveData.trainName || trainInfo.name || `Train #${liveData.trainNumber}`;

  // Route Source & Destination
  document.getElementById('drawerSourceCode').innerText = trainInfo.source?.code || 'ORIGIN';
  document.getElementById('drawerSourceName').innerText = trainInfo.source?.name || '';
  document.getElementById('drawerDestCode').innerText = trainInfo.destination?.code || 'DEST';
  document.getElementById('drawerDestName').innerText = trainInfo.destination?.name || '';

  // Run state first: it decides whether the numbers below are meaningful.
  const showProgress = renderRunState(liveData);
  const isRunning = liveData.runState ? liveData.runState.state === 'running' : true;

  // Delay & Status
  const delayBadge = document.getElementById('drawerDelayBadge');
  const delayMinutes = liveData.delayMinutes ?? 0;
  if (!isRunning && liveData.runState
      && (liveData.runState.state === 'not-running-today'
          || liveData.runState.state === 'unknown'
          || liveData.runState.state === 'scheduled-today')) {
    // "On Time" is a statement about a train that is moving. A train that is not
    // running cannot be on time, and the green pill made it look tracked.
    delayBadge.className = 'delay-badge-pill';
    delayBadge.innerHTML = '— Not tracking';
  } else if (delayMinutes <= 0) {
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

  // ⚠️ Crowdsourced hazard reports affecting this route
  renderHazardPanel(liveData);

  // Current Position
  const posText = currentLoc.stationName
    ? `${currentLoc.status === 'departed' ? 'Departed from' : 'Approaching'} ${currentLoc.stationName}`
    : (liveData.status === 'running' ? 'En Route' : 'Scheduled');
  document.getElementById('drawerCurrentPos').innerText = posText;

  // Next Halt
  if (nextHalt.stationName) {
    document.getElementById('drawerNextHalt').innerText = `Next halt: ${nextHalt.stationName} (Seq ${nextHalt.sequence || ''})`;
  } else if (trainInfo.destination?.name) {
    document.getElementById('drawerNextHalt').innerText = `Destination: ${trainInfo.destination.name}`;
  } else {
    document.getElementById('drawerNextHalt').innerText = '';
  }

  // Dynamic GPS Velocity & Horizon Blending Telemetry
  const velBadge = document.getElementById('drawerVelocityBadge');
  const speedRow = document.getElementById('drawerSpeedTelemetry');
  const liveVel = liveData.liveVelocity;

  if (liveVel?.isLive) {
    if (velBadge) {
      velBadge.style.display = 'inline-block';
      velBadge.title = liveVel.basisLabel || 'Real-time GPS velocity';
    }
    if (speedRow) {
      speedRow.style.display = 'block';
      let etaAdjustmentHtml = '';
      if (liveVel.deltaEtaNextHaltMin != null && Math.abs(liveVel.deltaEtaNextHaltMin) >= 0.2) {
        const sign = liveVel.deltaEtaNextHaltMin > 0 ? '+' : '';
        const color = liveVel.deltaEtaNextHaltMin > 0 ? '#fbbf24' : '#34d399';
        etaAdjustmentHtml = ` · Next halt ETA blended: <span style="color:${color};font-weight:600;">${sign}${liveVel.deltaEtaNextHaltMin}m</span> (eff. ${liveVel.blendedSpeedNextHaltKmph} km/h)`;
      }
      speedRow.innerHTML = `
        <span style="color:#38bdf8;font-weight:600;">⚡ Speed: ${liveVel.liveSpeedKmph} km/h</span>
        <span style="color:#94a3b8;font-size:0.72rem;">(${escapeHtml(liveVel.phase)}${liveVel.instantKmph != null ? `, instant: ${liveVel.instantKmph} km/h` : ''})</span>
        ${etaAdjustmentHtml}
      `;
    }
  } else {
    if (velBadge) velBadge.style.display = 'none';
    if (speedRow) {
      const schedSpeed = currentLoc.speedToNextStationKmph || currentLoc.speedKmh || trainInfo.avgSpeed;
      if (Number.isFinite(Number(schedSpeed))) {
        speedRow.style.display = 'block';
        speedRow.innerHTML = `<span style="color:#94a3b8;" title="Schedule-derived block speed — not a live GPS reading">Speed (sched): ${Math.round(Number(schedSpeed))} km/h</span>`;
      } else {
        speedRow.style.display = 'none';
        speedRow.innerHTML = '';
      }
    }
  }

  // Live Meteorological Telemetry
  const wxBadge = document.getElementById('drawerWeatherBadge');
  const wxDetails = document.getElementById('drawerWeatherDetails');
  const wx = liveData.weather;

  if (wx?.available) {
    if (wxBadge) {
      wxBadge.style.display = 'inline-block';
      const tempStr = wx.tempC != null ? ` ${wx.tempC}°C` : '';
      wxBadge.innerHTML = `${wx.icon || '🌤️'} ${escapeHtml(wx.label || 'Weather')}${tempStr}`;
      wxBadge.title = `Atmospheric condition: ${wx.label}, Visibility: ${wx.visibilityM}m, Precip: ${wx.precipMmH} mm/h (source: Open-Meteo)`;
    }
    if (wxDetails) {
      if (wx.factor < 0.99 || wx.precipMmH > 0 || wx.visibilityM < 2000) {
        wxDetails.style.display = 'block';
        const impactLabel = wx.factor < 0.99
          ? `<strong style="color:#fbbf24;">Weather caution: speed factor ${wx.factor}</strong> · `
          : '';
        wxDetails.innerHTML = `
          <span>${wx.icon || ''} ${impactLabel}Rain: ${wx.precipMmH} mm/h · Visibility: ${(wx.visibilityM / 1000).toFixed(1)} km · Wind: ${wx.windSpeedKmh} km/h</span>
        `;
      } else {
        wxDetails.style.display = 'none';
        wxDetails.innerHTML = '';
      }
    }
  } else {
    if (wxBadge) wxBadge.style.display = 'none';
    if (wxDetails) {
      wxDetails.style.display = 'none';
      wxDetails.innerHTML = '';
    }
  }

  // Historical Delay Confidence Bands
  const confBadge = document.getElementById('drawerConfidenceBadge');
  const confDetails = document.getElementById('drawerConfidenceDetails');
  const cb = liveData.curvatureEta?.totals?.confidence_bands;
  if (cb?.available && cb.uncertainty_min_80 != null) {
    if (confBadge) {
      confBadge.style.display = 'inline-block';
      confBadge.innerHTML = `📊 ±${cb.uncertainty_min_80}m (80%)`;
      confBadge.title = `80% Confidence Band: ±${cb.uncertainty_min_80}m, 95% Stress Band: ±${cb.uncertainty_min_95}m based on n=${cb.sample_count} empirical runs`;
    }
    if (confDetails) {
      confDetails.style.display = 'block';
      confDetails.innerHTML = `
        <span style="color:#c084fc;font-weight:600;">📊 Confidence Band: ±${cb.uncertainty_min_80} min (80% operational)</span>
        <span style="color:#94a3b8;font-size:0.72rem;"> · Worst-case: ±${cb.uncertainty_min_95} min (95% stress, n=${cb.sample_count})</span>
      `;
    }
  } else {
    if (confBadge) confBadge.style.display = 'none';
    if (confDetails) {
      confDetails.style.display = 'none';
      confDetails.innerHTML = '';
    }
  }

  // Progress bar — shown only when there is a real distance to report.
  // Hidden outright otherwise: a bar at 0% still reads as a measurement, and
  // the old `pct || 15` painted 15% for a train sitting at its origin, because
  // `0 || 15 === 15`.
  const progressBlock = document.getElementById('progressBlock');
  const totalDist = Number.isFinite(Number(trainInfo.distance)) ? Number(trainInfo.distance) : null;
  const rawCovered = currentLoc.distanceFromOriginKm
    ?? route.find((s) => s.sequence === currentLoc.sequence)?.distance
    ?? null;
  const coveredDist = Number.isFinite(Number(rawCovered)) ? Number(rawCovered) : null;

  if (progressBlock) {
    if (!showProgress || totalDist === null || coveredDist === null) {
      progressBlock.style.display = 'none';
      // Blank the numbers too, don't just hide them. The drawer is one set of
      // elements reused for every train, so a covered-km left behind belongs to
      // the previously-open train — and the untouched static markup in
      // index.html ("280 km covered (40%)") belongs to no train at all. Either
      // one becomes a wrong measurement the instant something reveals the block.
      document.getElementById('drawerProgressFill').style.width = '0%';
      document.getElementById('drawerCoveredKm').innerText = '—';
      document.getElementById('drawerTotalKm').innerText = '—';
    } else {
      progressBlock.style.display = '';
      const pct = Math.min(100, Math.max(0, Math.round((coveredDist / totalDist) * 100)));
      // `${pct}%` with no `||` fallback: 0 must render as 0.
      document.getElementById('drawerProgressFill').style.width = `${pct}%`;
      document.getElementById('drawerCoveredKm').innerText = `${coveredDist} km covered (${pct}%)`;
      document.getElementById('drawerTotalKm').innerText = `${totalDist} km total`;
    }
  }

  // GATI Dynamic Multi-Layer Predictive ETA vs ConfirmTkt Naive Delay
  renderGatiEtaComparison(liveData);

  // Render Coach Composition.
  // Both sources are passed: the structured payload carries class names and berth
  // counts, the string is the bare formation. Passing only `a || b` meant a
  // structured payload that failed to parse could never fall through to the string.
  renderCoaches(coachesData, trainInfo.coachPosition);

  // Render Halts Timeline
  renderTimeline(route, currentLoc, isRunning || (liveData.runState?.state === 'completed'), liveData.curvatureEta);

  drawer.classList.add('open');
}

// Render Coach Boxes
//
// Real rake composition or nothing. The previous fallback drew a made-up
// 8-coach rake — ENG/GEN/S1/S2/B1/B2/A1/SLRD — for any train whose composition
// we did not have, which is a specific, checkable claim about a physical train.
//
// Removing that fabrication immediately exposed a parse bug it had been hiding
// (VERIFIED #9 again): this function looked for `coachesData.coaches`, a key the
// upstream payload does not have at the top level. The real formation is at
// `.rake` (structured, with class names and berth counts) and `.legs[i].coaches`;
// `.coaches` only exists nested inside a leg. Every shape is handled below, in
// descending order of information, and the bare `coachPosition` string — carried
// on both `train` and `route[0]` — is the last resort.
function renderCoaches(coachesData, formationString) {
  const container = document.getElementById('coachRakeContainer');
  container.innerHTML = '';

  // Ordered richest-first: `rake` has classType + className + totalBerths.
  const structured =
    (Array.isArray(coachesData?.rake) && coachesData.rake.length && coachesData.rake)
    || (Array.isArray(coachesData?.legs?.[0]?.coaches) && coachesData.legs[0].coaches.length
        && coachesData.legs[0].coaches)
    || (Array.isArray(coachesData?.coaches) && coachesData.coaches.length && coachesData.coaches)
    || null;

  // Strings can arrive as the argument itself, on the payload, or on the leg.
  const asString = [
    typeof coachesData === 'string' ? coachesData : null,
    coachesData?.coachPosition,
    coachesData?.legs?.[0]?.formation,
    formationString,
  ].find((v) => typeof v === 'string' && v.trim());

  let coachList = [];
  if (structured) {
    coachList = structured
      .slice()
      // `position` is 1-based in the payload; sort on it rather than trusting
      // array order, and fall back to array order when it is absent.
      .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0))
      .map((c) => ({
        code: String(c.code || '').trim(),
        classType: c.classType || c.category || null,
        className: c.className || null,
        berths: Number.isFinite(Number(c.totalBerths)) ? Number(c.totalBerths) : null,
      }))
      .filter((c) => c.code);
  } else if (asString) {
    coachList = asString.split('-')
      .map((code) => code.trim())
      .filter(Boolean)
      .map((code) => ({ code, classType: null, className: null, berths: null }));
  }

  if (coachList.length === 0) {
    container.innerHTML = '<div style="font-size: 0.75rem; color: var(--text-dim); '
      + 'padding: 8px 10px; background: rgba(148,163,184,0.06); border-radius: 6px; '
      + 'border: 1px solid rgba(148,163,184,0.15);">Coach composition not published '
      + 'for this train in the prototype data source.</div>';
    return;
  }

  coachList.forEach((c) => {
    const box = document.createElement('div');
    const code = c.code.toUpperCase();

    // Prefer the payload's own classType. The code-substring chain below is only
    // for the bare-string path, and it is order-sensitive: `includes('C')` matches
    // almost any code, so it must be tested after the specific classes, never before.
    const type = (c.classType || '').toUpperCase();
    let cls;
    if (type) {
      if (type === 'EC' || type === 'EA' || type === 'EV') cls = 'ec';
      else if (type === 'CC' || type === '2S') cls = 'cc';
      else if (type === 'SL') cls = 'sl';
      else if (type === 'GN' || type === 'GS' || type === 'UR') cls = 'gen';
      else if (type === '1A' || type === '2A' || type === '3A' || type === '3E') cls = 'ac';
    }
    if (!cls) {
      if (code.includes('ENG') || code.includes('LOCO') || code.startsWith('LP')) cls = 'eng';
      else if (code.startsWith('E')) cls = 'ec';
      else if (code.includes('GEN') || code.includes('UR') || code.includes('GS')) cls = 'gen';
      else if (code.startsWith('S') || code.startsWith('D')) cls = 'sl';
      else if (code.startsWith('C')) cls = 'cc';
      else cls = 'ac';
    }

    box.className = `coach-box ${cls}`;
    box.innerText = code;
    // Only state what the payload actually carried — no invented class names.
    box.title = [
      `Coach ${code}`,
      c.className || (c.classType ? `Class ${c.classType}` : null),
      c.berths !== null ? `${c.berths} berths/seats` : null,
    ].filter(Boolean).join(' · ');
    container.appendChild(box);
  });

  // A train whose formation changes en route has more than one leg. Saying so is
  // cheaper than silently showing the first leg as if it were the whole journey.
  const legCount = Array.isArray(coachesData?.legs) ? coachesData.legs.length : 0;
  const reversals = Array.isArray(coachesData?.stationVariations?.reversals)
    ? coachesData.stationVariations.reversals.length : 0;
  const notes = [];
  if (legCount > 1) {
    const leg = coachesData.legs[0];
    notes.push(`Composition changes en route (${legCount} legs) — showing `
      + `${leg.fromStation || 'origin'}→${leg.toStation || 'destination'}.`);
  }
  if (reversals > 0) {
    notes.push(`Direction reverses at ${reversals} station${reversals > 1 ? 's' : ''}, `
      + 'so coach order on the platform flips there.');
  }
  if (!structured && asString) {
    notes.push('Formation string only — class and berth details not published for this train.');
  }
  if (notes.length) {
    const note = document.createElement('div');
    note.style.cssText = 'font-size: 0.67rem; color: var(--text-dim); margin-top: 6px; '
      + 'line-height: 1.4; flex-basis: 100%;';
    note.innerText = notes.join(' ');
    container.appendChild(note);
  }
}

// Render Journey Timeline Halts
// Render Journey Timeline Halts
// `isLive` says whether this run is actually happening — it decides whether a
// zero delay may be rendered as the claim "On Time" or only as "Scheduled".
function renderTimeline(route, currentLoc, isLive = true, curvatureEta = null) {
  const list = document.getElementById('timelineHaltsList');
  list.innerHTML = '';
  const timelineIsLive = isLive !== false;

  const halts = route.filter(s => s.isHalt);
  const displayList = halts.length > 0 ? halts : route.slice(0, 30);
  const haltsEta = curvatureEta?.halts_eta || {};

  displayList.forEach((s) => {
    const isPassed = s.status === 'departed' || s.status === 'arrived';
    const isCurrent = s.sequence === currentLoc.sequence;

    const item = document.createElement('div');
    item.className = `timeline-item ${isPassed ? 'passed' : ''} ${isCurrent ? 'current' : ''}`;

    const scheduledTime = s.scheduledArrival || s.scheduledDeparture || '--:--';
    const timeStr = scheduledTime.includes('T') ? scheduledTime.split('T')[1].slice(0, 5) : scheduledTime;

    const ntesDelay = s.delayDeparture ?? s.delayArrival ?? 0;
    const code = s.stationCode;
    const gatiInfo = haltsEta[code];

    let timeColHtml = '';

    if (isPassed) {
      // Historical/already passed halt: show recorded arrival/departure
      const delayHtml = ntesDelay > 0
        ? `<div class="time-delay-tag" style="color: #fbbf24; font-size: 0.7rem; font-weight: 600;">+${ntesDelay}m</div>`
        : (timelineIsLive
          ? '<div class="time-ontime-tag" style="color: #34d399; font-size: 0.7rem;">On Time</div>'
          : '<div class="time-ontime-tag" style="color: #64748b; font-size: 0.7rem;">Scheduled</div>');

      let actualTimeStr = timeStr;
      if (ntesDelay > 0 && scheduledTime !== '--:--') {
        try {
          const date = scheduledTime.includes('T') ? new Date(scheduledTime) : new Date();
          if (!scheduledTime.includes('T')) {
            const [hh, mm] = scheduledTime.split(':').map(Number);
            date.setHours(hh, mm, 0, 0);
          }
          if (!isNaN(date.getTime())) {
            date.setMinutes(date.getMinutes() + ntesDelay);
            actualTimeStr = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
          }
        } catch (e) {}
      }

      timeColHtml = `
        <div style="font-weight: 700; font-size: 0.85rem; color: var(--text-main);">${actualTimeStr}</div>
        <div style="font-size: 0.7rem; color: var(--text-dim); ${ntesDelay > 0 ? 'text-decoration: line-through;' : ''}">${timeStr}</div>
        ${delayHtml}
      `;
    } else {
      // Upcoming or current station: Display GATI multi-layer forecast!
      if (gatiInfo && gatiInfo.predicted_arrival) {
        const gatiIso = gatiInfo.predicted_arrival;
        const gatiTimeStr = gatiIso.includes('T') ? gatiIso.split('T')[1].slice(0, 5) : gatiIso;
        const gatiDelay = Math.round(gatiInfo.predicted_delay_min);
        const gatiColor = gatiDelay > 30 ? '#f87171' : (gatiDelay > 0 ? '#fbbf24' : '#34d399');

        // ConfirmTkt naive flat comparison time
        let ntesTimeStr = timeStr;
        if (ntesDelay > 0 && scheduledTime !== '--:--') {
          try {
            const date = scheduledTime.includes('T') ? new Date(scheduledTime) : new Date();
            if (!scheduledTime.includes('T')) {
              const [hh, mm] = scheduledTime.split(':').map(Number);
              date.setHours(hh, mm, 0, 0);
            }
            if (!isNaN(date.getTime())) {
              date.setMinutes(date.getMinutes() + ntesDelay);
              ntesTimeStr = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
            }
          } catch (e) {}
        }

        const holdBadge = (gatiInfo.conflict_hold_min && gatiInfo.conflict_hold_min > 0)
          ? `<div style="font-size: 0.65rem; color: #f59e0b; font-weight: 700; background: rgba(245, 158, 11, 0.15); padding: 1px 4px; border-radius: 4px; margin-top: 1px;">⚠️ +${gatiInfo.conflict_hold_min}m loop hold</div>`
          : '';

        timeColHtml = `
          <div style="display: flex; align-items: center; gap: 4px;">
            <span style="font-size: 0.6rem; font-weight: 700; color: #38bdf8; background: rgba(56, 189, 248, 0.18); padding: 1px 4px; border-radius: 3px; letter-spacing: 0.4px;">GATI</span>
            <span style="color: ${gatiColor}; font-weight: 800; font-size: 0.88rem;">${gatiTimeStr}</span>
            <span style="color: ${gatiColor}; font-size: 0.72rem; font-weight: 700;">+${gatiDelay}m</span>
          </div>
          ${holdBadge}
          <div style="font-size: 0.68rem; color: var(--text-dim); text-decoration: line-through; margin-top: 1px;">
            ${timeStr} (Sched)
          </div>
          <div style="font-size: 0.65rem; color: #64748b; margin-top: 1px;" title="ConfirmTkt repeats flat delay without physics or crossing loop holds">
            ConfirmTkt: <span style="${ntesDelay !== gatiDelay ? 'text-decoration: line-through;' : ''}">${ntesTimeStr} (+${ntesDelay}m)</span>
          </div>
        `;
      } else {
        // Fallback when GATI model cache is absent: show standard scheduled + ntes
        let expectedTimeHtml = '';
        if (ntesDelay > 0 && scheduledTime !== '--:--') {
          try {
            const date = scheduledTime.includes('T') ? new Date(scheduledTime) : new Date();
            if (!scheduledTime.includes('T')) {
              const [hh, mm] = scheduledTime.split(':').map(Number);
              date.setHours(hh, mm, 0, 0);
            }
            if (!isNaN(date.getTime())) {
              date.setMinutes(date.getMinutes() + ntesDelay);
              const expH = String(date.getHours()).padStart(2, '0');
              const expM = String(date.getMinutes()).padStart(2, '0');
              expectedTimeHtml = `<div class="time-expected" style="color: #fbbf24; font-weight: 700; font-size: 0.85rem;">${expH}:${expM}</div>`;
            }
          } catch (e) {}
        }

        const scheduledDisplayHtml = ntesDelay > 0
          ? `<div class="time-scheduled-crossed" style="font-size: 0.72rem; color: var(--text-dim); text-decoration: line-through;">${timeStr}</div>`
          : `<div class="time-scheduled" style="font-weight: 700; font-size: 0.85rem; color: var(--text-main);">${timeStr}</div>`;

        const delayHtml = ntesDelay > 0
          ? `<div class="time-delay-tag" style="color: #fbbf24; font-size: 0.7rem; font-weight: 600;">+${ntesDelay}m</div>`
          : (timelineIsLive
            ? '<div class="time-ontime-tag" style="color: #34d399; font-size: 0.7rem;">On Time</div>'
            : '<div class="time-ontime-tag" style="color: #64748b; font-size: 0.7rem;">Scheduled</div>');

        timeColHtml = `
          ${scheduledDisplayHtml}
          ${expectedTimeHtml}
          ${delayHtml}
        `;
      }
    }

    const platformHtml = (s.platform !== null && s.platform !== undefined && s.platform !== '')
      ? `Platform ${s.platform} &bull; `
      : '';
    const distHtml = Number.isFinite(Number(s.distance)) ? `${Number(s.distance)} km` : '';
    const metaLine = `${platformHtml}${distHtml}`.replace(/ &bull; $/, '');

    item.innerHTML = `
      <div class="timeline-dot"></div>
      <div>
        <div class="station-title">${s.stationName || s.stationCode}</div>
        <div class="station-meta-sub">${metaLine || '&nbsp;'}</div>
      </div>
      <div class="station-time-col" style="text-align: right; display: flex; flex-direction: column; justify-content: center; align-items: flex-end;">
        ${timeColHtml}
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
  const gatiComp = document.getElementById('drawerGatiEtaComparison');
  if (gatiComp) gatiComp.style.display = 'none';
  
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
    item.dataset.trainNumber = String(t.number);
    item.innerHTML = `
      <div class="search-item-left">
        <div class="train-pill">${t.number}</div>
        <div class="search-item-info">
          <span class="search-item-title">${t.name}</span>
          <span class="search-item-route">${t.sourceName || t.source || ''} &rarr; ${t.destName || t.dest || ''}</span>
          <span class="search-item-runstate" style="font-size: 0.68rem; color: #64748b;">checking run day…</span>
        </div>
      </div>
      <div class="search-type-badge">${t.type || '—'}</div>
    `;

    item.addEventListener('click', () => {
      document.getElementById('searchInput').value = `${t.number} - ${t.name}`;
      dropdown.classList.remove('active');
      selectTrain(t.number);
    });

    dropdown.appendChild(item);
  });

  dropdown.classList.add('active');
  // Badges fill in after the list is on screen: the dropdown must not wait on 8
  // lookups, and a slow/absent model must leave a usable list rather than none.
  annotateSearchRunStates(trains.slice(0, 8), dropdown);
}

// ── Search result labelling ─────────────────────────────────────────────────
// Search stays UPSTREAM and ALL-INDIA — the searchable set and its quota cost are
// unchanged. What is added is honesty about what the result supports: whether the
// train runs today, and whether it is on the Konkan corridor at all. A Delhi
// train is findable here, but it has no tunnel layer and no crossing prediction,
// and saying so up front beats an empty panel after the click.
//
// Costs zero upstream RailRadar requests: /api/model/run-state is cache-only
// (roster calendar), cached 300 s at the gateway and for the session here.
async function annotateSearchRunStates(trains, dropdown) {
  await Promise.all(trains.map(async (t) => {
    const num = String(t.number);
    let rs = clientCache.runState.get(num);
    if (rs === undefined) {
      try {
        const res = await fetch(apiUrl(`/api/model/run-state/${encodeURIComponent(num)}`));
        const json = await res.json();
        rs = (json && json.success && json.data) ? json.data : null;
      } catch {
        rs = null;
      }
      clientCache.runState.set(num, rs);
    }

    const el = dropdown.querySelector(`.search-item[data-train-number="${num}"] .search-item-runstate`);
    if (!el) return;   // dropdown moved on while we were fetching

    if (!rs) {
      // Unknown is not "does not run" (VERIFIED #9) — say which one this is.
      el.style.color = '#64748b';
      el.textContent = 'run day unknown';
      return;
    }
    if (rs.isCorridorTrain === false) {
      el.style.color = '#94a3b8';
      el.textContent = '⚠ outside Konkan corridor · limited features';
      return;
    }
    if (rs.runsToday === true) {
      el.style.color = '#34d399';
      el.textContent = '● runs today';
    } else if (rs.runsToday === false) {
      el.style.color = '#fbbf24';
      el.textContent = rs.nextRunDate
        ? `⏸ not running today · next ${rs.nextRunDate}`
        : '⏸ not running today';
    } else {
      el.style.color = '#64748b';
      el.textContent = 'run day unknown (no calendar)';
    }
  }));
}

// Setup Event Listeners
function setupEventListeners() {
  document.getElementById('layerToggleBtn').addEventListener('click', toggleMapLayer);

  // Corridor-wide scheduled crossings. Opt-in, so nothing about the existing
  // live view changes until it is asked for.
  const corridorBtn = document.getElementById('corridorToggleBtn');
  if (corridorBtn) corridorBtn.addEventListener('click', toggleCorridorLayer);
  const corridorClose = document.getElementById('corridorLegendClose');
  if (corridorClose) {
    corridorClose.addEventListener('click', () => {
      // The × hides the legend AND the layer when it is on, so the two can never
      // disagree about whether the corridor markers are drawn. When the legend is
      // showing an unavailable message the layer is already off — just hide it.
      if (corridorLayerOn) {
        toggleCorridorLayer();
      } else {
        document.getElementById('corridorLegend').hidden = true;
      }
    });
  }

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

// ================================================================
//  PHASE 7 — CROWDSOURCED HAZARD REPORTING  (USP #5)
// ================================================================
// Everything else this app draws is INFERRED: curvature from geometry, delay from
// timetables, crossings from two schedules. None of it can see a failed locomotive
// or a boulder on the line. This layer is the only genuinely live, genuinely ours
// data source in the system — and the only one a passenger writes to.
//
// Two rules govern the whole module and are not negotiable:
//   1. A machine score can raise a report to `corroborated` at MOST. Only a human
//      controller confirms one, and only a confirmed report may touch an ETA.
//   2. Every number shown carries its basis. The confidence value is a weighted
//      heuristic with no ground truth behind it, and it is labelled as such
//      everywhere it appears — the same discipline as `axisBasis`, `delayBasis`
//      and `loopBasis` elsewhere in this file.
//
// The client does NO scoring arithmetic of its own. Confidence, status and the
// five components all arrive from the gateway, exactly as the tunnel and conflict
// layers already work, so the two can never drift apart.

let hazardLayer = null;
let hazardData = null;          // last /api/hazards payload (session cache)
let hazardLayerOn = false;
let hazardPickMode = false;     // map-click is arming a report location
let hazardDraft = { lat: null, lng: null, accuracyM: null, source: null, photo: null };
// Bumped on every modal open. A geolocation fix can take the full 10 s timeout, so
// a callback can outlive the form that asked for it — the reporter may have closed
// the modal, reopened it, or already picked a spot on the map by the time the fix
// lands. Comparing the sequence lets a late callback drop itself instead of writing
// coordinates into a draft that is no longer the one on screen. Without this an
// auto-fix silently overwrites a deliberate manual pick, which is the worst
// possible failure for a location: wrong, and invisibly so.
let hazardDraftSeq = 0;

/** Fill colour by status. Saturation tracks verification — see app.css. */
function hazardColour(status) {
  return {
    confirmed: '#ec4899',
    corroborated: '#f472b6',
    candidate: '#f9a8d4',
    logged: '#9d7186',
    rejected: '#475569',
  }[status] || '#9d7186';
}

// Mirrors `HAZARD_CATEGORIES` in src/services/hazardStore.js. Kept as a literal
// rather than fetched because the popup must render with no network — but the
// FALLBACK below is what matters: a category the client does not know prints its
// raw code, never `undefined`. A report filed from a newer store would otherwise
// render as "undefined" in the very popup an operator decides on.
const HAZARD_CATEGORY_LABEL = {
  'landslide': 'Landslide / rockfall',
  'flooding': 'Flooding / waterlogging',
  'track-damage': 'Visible track damage',
  'obstruction': 'Track obstruction',
  'fire': 'Fire / smoke',
  'signal-failure': 'Signal failure',
  'engine-failure': 'Engine / loco failure',
  'medical': 'Medical emergency',
  'overcrowding': 'Severe overcrowding',
  'unusual-stop': 'Unexplained prolonged halt',
  'other': 'Something else',
};
const hazardCategoryLabel = (c) => HAZARD_CATEGORY_LABEL[c] || String(c);

// ── Layer toggle ────────────────────────────────────────────────────────────
async function toggleHazardLayer() {
  const btn = document.getElementById('hazardToggleBtn');
  const legend = document.getElementById('hazardLegend');
  if (!hazardLayer || !map) return;

  if (hazardLayerOn) {
    map.removeLayer(hazardLayer);
    hazardLayerOn = false;
    if (btn) btn.setAttribute('aria-pressed', 'false');
    if (legend) legend.hidden = true;
    return;
  }

  // Always refetch: unlike the corridor sweep (date-stable timetables), the hazard
  // store is mutated by users submitting and by an admin approving. A session cache
  // could show a report as unconfirmed seconds after a controller confirmed it.
  if (btn) btn.classList.add('is-busy');
  try {
    const res = await fetch(apiUrl('/api/hazards'));
    const json = await res.json();
    if (!json.success || !json.data) {
      showHazardLayerUnavailable(json.reason, json.detail || json.hint);
      return;
    }
    hazardData = json.data;
    renderHazardMarkers(hazardData);
  } catch (err) {
    console.error('Hazard fetch failed:', err);
    showHazardLayerUnavailable('gateway-unreachable',
      'the hazard store is served by the Node gateway on :5050');
    return;
  } finally {
    if (btn) btn.classList.remove('is-busy');
  }

  hazardLayer.addTo(map);
  hazardLayerOn = true;
  if (btn) btn.setAttribute('aria-pressed', 'true');
  if (legend) legend.hidden = false;
}

function showHazardLayerUnavailable(reason, hint) {
  const legend = document.getElementById('hazardLegend');
  const count = document.getElementById('hazardLegendCount');
  const note = document.getElementById('hazardLegendNote');
  const btn = document.getElementById('hazardToggleBtn');
  if (!legend) return;
  legend.hidden = false;
  if (btn) btn.setAttribute('aria-pressed', 'false');
  if (count) count.textContent = 'Hazard reports unavailable';
  if (note) {
    note.textContent =
      `Hazard reports could not be loaded (${reason || 'unknown reason'}). ` +
      `${hint || ''} This is a gap, not an all-clear — do not read an empty map as "no hazards".`.trim();
  }
}

// ── Markers ─────────────────────────────────────────────────────────────────
// Radius encodes confidence, fill encodes status. Two channels because colour
// alone is not readable for every user, and because the two facts are genuinely
// independent: a low-confidence report can be human-confirmed, and a
// high-confidence one can still be waiting for a controller.
function renderHazardMarkers(data) {
  if (!hazardLayer) return;
  hazardLayer.clearLayers();

  const reports = Array.isArray(data.reports) ? data.reports : [];
  let drawn = 0, confirmed = 0;

  for (const r of reports) {
    if (r.lat == null || r.lng == null) continue;
    if (r.status === 'rejected') continue;   // decided against by a human; not a live hazard

    const conf = (r.scoring && r.scoring.confidence) || 0;
    const colour = hazardColour(r.status);
    const radius = 5 + Math.round(conf * 6);          // 5–11 px
    const isConfirmed = r.status === 'confirmed';
    if (isConfirmed) confirmed++;

    // A confirmed hazard gets a halo: it is the only class that can change an ETA,
    // so it must be findable at a glance rather than by reading every marker.
    if (isConfirmed) {
      hazardLayer.addLayer(L.circleMarker([r.lat, r.lng], {
        radius: radius + 5, color: colour, weight: 2,
        fillColor: colour, fillOpacity: 0.12,
      }));
    }

    const marker = L.circleMarker([r.lat, r.lng], {
      radius,
      color: 'rgba(15,23,42,0.9)',
      weight: 1.5,
      fillColor: colour,
      fillOpacity: 0.9,
    });

    marker.bindPopup(hazardPopupHtml(r), { maxWidth: 320 });
    hazardLayer.addLayer(marker);
    drawn++;
  }

  const count = document.getElementById('hazardLegendCount');
  const note = document.getElementById('hazardLegendNote');
  if (count) count.textContent = `${drawn} hazard report${drawn === 1 ? '' : 's'}`;
  if (note) {
    const undrawable = reports.filter(r => r.lat == null || r.lng == null).length;
    const synthetic = reports.filter(r => r.isSynthetic).length;
    note.innerHTML =
      `Marker size = confidence, colour = how far it has been verified. ` +
      `<strong>${confirmed}</strong> human-confirmed (the only kind that can affect an ETA).` +
      (synthetic ? ` ${synthetic} seeded demo report${synthetic === 1 ? '' : 's'}, labelled DEMO.` : '') +
      (undrawable ? ` ${undrawable} without coordinates, not drawn.` : '') +
      ` Confidence is an untuned heuristic, not a validated model.`;
  }
}

function hazardPopupHtml(r) {
  const s = r.scoring || {};
  const comps = s.components || {};
  const conf = s.confidence != null ? s.confidence : null;
  const colour = hazardColour(r.status);

  // Every component is listed separately WITH its basis. A single 0.75 would be
  // the opaque-number failure VERIFIED #9 warns about — the operator has to be
  // able to see that a report scored well because three independent devices
  // reported it, not because one person wrote a long description.
  const componentRows = Object.entries(comps).map(([name, c]) => {
    const pct = Math.round((c.score || 0) * 100);
    const label = name.replace(/([A-Z])/g, ' $1').replace(/^./, m => m.toUpperCase());
    return `<div style="display:flex;align-items:center;gap:6px;margin-top:3px">
              <span style="flex:0 0 108px;font-size:0.66rem;color:#475569">${escapeHtml(label)}</span>
              <span style="flex:1;height:5px;background:rgba(148,163,184,0.2);border-radius:3px;overflow:hidden">
                <span style="display:block;height:100%;width:${pct}%;background:${colour}"></span>
              </span>
              <span style="flex:0 0 30px;text-align:right;font-size:0.64rem;color:#475569">${pct}%</span>
            </div>`;
  }).join('');

  const demo = r.isSynthetic ? `<span class="hazard-demo-badge">DEMO</span>` : '';
  const photo = r.hasPhoto
    ? `<div style="margin-top:6px"><img src="${apiUrl(`/api/hazards/${encodeURIComponent(r.id)}/photo`)}"
         alt="Reported hazard" style="max-width:100%;border-radius:6px;display:block"></div>`
    : '';

  const km = comps.corridorPlausibility && comps.corridorPlausibility.corridorKm;
  const offset = comps.corridorPlausibility && comps.corridorPlausibility.offsetM;

  return `<div style="font-family:system-ui,sans-serif;min-width:250px">
    <div style="font-weight:700;font-size:0.9rem;color:${colour}">
      ${escapeHtml(hazardCategoryLabel(r.category))}${demo}
    </div>
    <div style="color:#64748b;font-size:0.7rem;margin-bottom:5px">
      ${escapeHtml(r.status)}${r.statusSource === 'human-decision'
        ? ' · confirmed by a controller'
        : ' · machine-scored, awaiting human review'}
      ${km != null ? ` · corridor km ${Number(km).toFixed(1)}` : ''}
    </div>
    ${r.description ? `<div style="font-size:0.76rem;color:#1e293b;margin-bottom:5px">${escapeHtml(r.description)}</div>` : ''}
    ${photo}
    <div style="margin-top:7px;padding-top:6px;border-top:1px solid rgba(148,163,184,0.25)">
      <div style="display:flex;justify-content:space-between;font-size:0.7rem;font-weight:700;color:#334155">
        <span>Confidence</span><span>${conf != null ? (conf * 100).toFixed(0) + '%' : 'n/a'}</span>
      </div>
      ${componentRows}
    </div>
    ${offset != null ? `<div style="font-size:0.64rem;color:#94a3b8;margin-top:5px">${offset} m from the reference alignment</div>` : ''}
    <div style="font-size:0.64rem;color:#94a3b8;margin-top:6px;font-style:italic">
      Confidence is an untuned weighted heuristic, not a validated model. A score
      alone can never confirm a report — only a controller can. Decision support only.
    </div>
  </div>`;
}

// ── Drawer panel: hazards on THIS train's route ─────────────────────────────
function renderHazardPanel(liveData) {
  const panel = document.getElementById('hazardPanel');
  const header = document.getElementById('hazardPanelHeader');
  const body = document.getElementById('hazardPanelBody');
  const gapBlock = document.getElementById('hazardUnavailable');
  const gapText = document.getElementById('hazardUnavailableText');
  if (!panel || !header || !body) return;

  const eta = liveData && liveData.curvatureEta;
  const hz = eta && eta.hazard_layer;

  // No ETA at all, or the layer was never asked for: say nothing rather than
  // implying an all-clear. An absent layer is not the same as zero hazards.
  //
  // Both elements are BLANKED, not merely hidden. The drawer reuses one set of
  // nodes across trains, so a hidden node still holds the last train's text and
  // any future branch that unhides without writing would show it — the exact
  // stale-DOM carry-over the run-state panel was caught by (§5e). Verified with a
  // 6-case synthetic sequence that deliberately runs each case over the previous
  // one's DOM.
  if (!hz) {
    panel.style.display = 'none';
    header.innerHTML = '';
    body.innerHTML = '';
    if (gapBlock) gapBlock.style.display = 'none';
    if (gapText) gapText.innerHTML = '';
    return;
  }

  // The store itself could not be read. This is the one case that must never
  // render as "no hazards" — it is an outage, and the operator has to know the
  // difference between "nothing reported" and "we cannot tell you".
  if (hz.available === false && hz.unavailable_reason) {
    panel.style.display = 'none';
    header.innerHTML = '';
    body.innerHTML = '';
    if (gapBlock && gapText) {
      gapBlock.style.display = 'block';
      gapText.innerHTML =
        `The hazard store could not be read, so crowdsourced reports are not being ` +
        `applied to this ETA. <strong>This is not an all-clear</strong> — it means the ` +
        `question could not be answered.` +
        `<div style="color:var(--text-dim);font-size:0.67rem;margin-top:4px">` +
        `Reason code: <code>${escapeHtml(hz.unavailable_reason)}</code></div>`;
    }
    return;
  }

  if (gapBlock) gapBlock.style.display = 'none';
  if (gapText) gapText.innerHTML = '';   // same stale-DOM rule as the two hidden branches
  panel.style.display = 'block';

  const applied = hz.applied_reports || [];
  const penalty = hz.total_penalty_min || 0;
  const inStore = hz.reports_in_store || 0;
  const confirmedCount = hz.confirmed_reports || 0;
  // Reports the model read and deliberately did not apply, with its own reason.
  const skipped = hz.skipped || [];
  const notConfirmed = skipped.filter(s => s.reason === 'not-human-confirmed').length;

  const active = applied.length > 0 && penalty > 0;
  const accent = active ? '#ec4899' : inStore ? '#f472b6' : '#94a3b8';

  panel.style.background = active
    ? 'rgba(236, 72, 153, 0.09)'
    : inStore ? 'rgba(244, 114, 182, 0.06)' : 'rgba(148, 163, 184, 0.06)';
  panel.style.border = `1px solid ${accent}33`;
  header.style.color = accent;

  header.innerHTML = active
    ? `<div style="display:flex;justify-content:space-between;align-items:center;width:100%">
         <span>⚠️ Hazard Restriction Active</span>
         <span style="background:rgba(236,72,153,0.22);color:#f9a8d4;font-size:0.72rem;padding:2px 8px;border-radius:12px;font-weight:700">
           +${penalty.toFixed(1)} min</span>
       </div>`
    : '⚠️ Crowdsourced Hazards';

  if (active) {
    // The restriction is real and costing minutes. Show WHICH span, at what cap,
    // against what normal speed — the same auditability the curvature and conflict
    // layers give, so the number can be checked rather than believed.
    const segs = (eta.segments || []).filter(s => (s.hazard_penalty_min || 0) > 0);
    const rows = segs.map(s => {
      const rs = s.hazard_restrictions || [];
      const detail = rs.map(x =>
        `<div style="font-size:0.7rem;color:var(--text-dim);margin-left:10px">` +
        `${escapeHtml((x.categories || []).map(hazardCategoryLabel).join(', '))} · ` +
        `${x.overlap_km} km capped to ${x.cap_kmph} km/h (normally ${x.normal_speed_kmh} km/h)` +
        `${x.is_synthetic ? ' <span class="hazard-demo-badge">DEMO</span>' : ''}</div>`
      ).join('');
      return `<div style="margin-top:5px">
                <strong style="color:var(--text-main)">${escapeHtml(s.from)}→${escapeHtml(s.to)}</strong>
                <span style="color:#f9a8d4;font-weight:700"> +${s.hazard_penalty_min.toFixed(2)} min</span>
                ${detail}
              </div>`;
    }).join('');

    body.innerHTML =
      `<strong style="color:var(--text-main)">${applied.length}</strong> confirmed hazard` +
      `${applied.length === 1 ? '' : 's'} on this route add` +
      `${applied.length === 1 ? 's' : ''} <strong style="color:#f9a8d4">${penalty.toFixed(1)} min</strong> ` +
      `to the predicted ETA.` +
      rows +
      `<div style="font-size:0.68rem;color:var(--text-dim);margin-top:7px">` +
        `Restrictions apply only to the reported <strong>sub-span</strong>, not the whole ` +
        `block — charging a block-wide cap here would overstate the cost by orders of ` +
        `magnitude. Speed caps are our heuristic, not sourced TSR values.</div>`;
  } else if (inStore > 0) {
    // The honest middle state, and the one most likely to be misread: reports
    // exist, the model read them, and it is deliberately not acting on them.
    body.innerHTML =
      `<strong style="color:var(--text-main)">${inStore}</strong> report` +
      `${inStore === 1 ? '' : 's'} in the store · ` +
      `<strong style="color:var(--text-main)">${confirmedCount}</strong> human-confirmed · ` +
      `<strong style="color:#f9a8d4">0 min</strong> applied to this ETA.` +
      (notConfirmed
        ? `<div style="margin-top:5px">${notConfirmed} report${notConfirmed === 1 ? ' is' : 's are'} ` +
          `scored but <strong>not yet confirmed by a controller</strong>, so ${notConfirmed === 1 ? 'it does' : 'they do'} ` +
          `not affect the ETA. That is the intended behaviour, not a gap.</div>`
        : '') +
      (confirmedCount > 0 && applied.length === 0
        ? `<div style="margin-top:5px;color:var(--text-dim)">Confirmed reports exist but none fall on ` +
          `this train's route, or their category implies no speed restriction ` +
          `(an engine failure is not a track restriction).</div>`
        : '') +
      `<div style="font-size:0.68rem;color:var(--text-dim);margin-top:7px">` +
        `A zero here is a <em>measurement</em>: the model read every report and ` +
        `applied none.</div>`;
  } else {
    body.innerHTML =
      `No hazard reports have been submitted for this corridor. ` +
      `<div style="font-size:0.68rem;color:var(--text-dim);margin-top:5px">` +
      `Use <strong>＋</strong> on the map to report an incident — engine failure, ` +
      `landslide, flooding or obstruction — that no sensor or timetable can detect.</div>`;
  }
}

// ── Report flow ─────────────────────────────────────────────────────────────
function openHazardModal() {
  const modal = document.getElementById('hazardModal');
  if (!modal) return;
  hazardDraftSeq += 1;
  hazardDraft = { lat: null, lng: null, accuracyM: null, source: null, photo: null };
  const desc = document.getElementById('hazardDescription');
  const note = document.getElementById('hazardSubmitNote');
  if (desc) desc.value = '';
  if (note) note.textContent = '';
  hazardClearPhoto();
  modal.hidden = false;

  // The user asked for the location to be taken automatically, so it is: the fix
  // is requested the moment the form opens, and by the time the reporter has
  // chosen a category and typed a line the coordinates are already in. "Use my
  // location" stays as an explicit retry, not as the only way in.
  //
  // This is also the only moment at which asking is defensible — a location
  // request on page load, before the reporter has expressed any intent, is the
  // pattern that trains people to deny the prompt outright.
  hazardAutoLocate();
}

/**
 * Fire geolocation for a newly-opened form, degrading LOUDLY.
 *
 * Never substitutes a plausible-looking default coordinate when the fix fails —
 * that is the fabrication class VERIFIED #30 was caught by, and a fabricated
 * hazard location is worse than no hazard at all: it puts a landslide on the
 * wrong stretch of track and scores it as corroborated evidence.
 */
function hazardAutoLocate() {
  // A phone *browser* pointed at http://192.168.x.y:5050 has no geolocation at
  // all — the API is restricted to secure contexts, so Chrome hides it and Safari
  // errors. The Capacitor app's origin is `capacitor://localhost`, which IS a
  // secure context, so the native build is unaffected. Say which case this is
  // rather than reporting a generic failure the reporter cannot act on.
  if (typeof window.isSecureContext === 'boolean' && !window.isSecureContext) {
    setHazardLocStatus(
      'Automatic location needs a secure connection (HTTPS or the GATI app), so ' +
      'this browser will not provide one over plain HTTP. Tap <strong>🗺 Pick on map</strong> ' +
      'to place the report yourself.'
    );
    return;
  }
  if (!navigator.geolocation) {
    setHazardLocStatus(
      'This device does not expose a location API. Tap <strong>🗺 Pick on map</strong> instead.'
    );
    return;
  }
  hazardUseGps({ auto: true });
}

function closeHazardModal() {
  const modal = document.getElementById('hazardModal');
  if (modal) modal.hidden = true;
  setHazardPickMode(false);
}

function setHazardLocStatus(text) {
  const el = document.getElementById('hazardLocStatus');
  if (el) el.innerHTML = text;
}

function setHazardPickMode(on) {
  hazardPickMode = on;
  document.body.classList.toggle('hazard-picking', on);
  const btn = document.getElementById('hazardPickMapBtn');
  if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  const modal = document.getElementById('hazardModal');
  // Hide (not close) the dialog while picking, so the map is usable and the
  // half-filled form is still there when the pin lands.
  if (modal && !modal.hidden && on) modal.style.visibility = 'hidden';
  if (modal && !on) modal.style.visibility = '';
}

function hazardUseGps(opts) {
  const auto = !!(opts && opts.auto);
  if (!navigator.geolocation) {
    setHazardLocStatus('This device does not expose a location API. Use “Pick on map” instead.');
    return;
  }
  const seq = hazardDraftSeq;
  setHazardLocStatus(
    auto
      ? 'Getting your location automatically… <span style="color:var(--text-muted)">' +
        '(you can also pick it on the map)</span>'
      : 'Locating…'
  );
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      // Drop a fix that belongs to a form that is no longer on screen.
      if (seq !== hazardDraftSeq) return;
      // An automatic fix must never overwrite a location the reporter chose
      // deliberately. A 10 s fix that lands after a map pick would otherwise move
      // the pin out from under them — and they would have no way to know.
      if (auto && hazardDraft.source && hazardDraft.source !== 'gps') return;
      hazardDraft.lat = pos.coords.latitude;
      hazardDraft.lng = pos.coords.longitude;
      hazardDraft.accuracyM = Math.round(pos.coords.accuracy);
      hazardDraft.source = 'gps';
      // Accuracy is shown, never hidden: a ±2 km fix and a ±8 m fix are different
      // evidence, and the confidence engine treats them differently too.
      setHazardLocStatus(
        `📍 ${hazardDraft.lat.toFixed(5)}, ${hazardDraft.lng.toFixed(5)} ` +
        `<span style="color:var(--text-dim)">(GPS, ±${hazardDraft.accuracyM} m` +
        `${auto ? ', taken automatically' : ''})</span>`
      );
    },
    (err) => {
      if (seq !== hazardDraftSeq) return;
      if (auto && hazardDraft.source) return;   // they already placed it by hand
      // The three failure codes need three different instructions. "Could not get
      // your location" tells a reporter who tapped Deny nothing they can act on,
      // and tells one standing in a tunnel to go change a browser setting.
      const codes = err && typeof err.code === 'number' ? err.code : 0;
      let why;
      if (codes === 1) {
        why = auto
          ? 'Location permission was declined, so nothing was read.'
          : 'Location permission is blocked for this site.';
      } else if (codes === 2) {
        why = 'Your device could not get a fix right now (no GPS or network positioning available).';
      } else if (codes === 3) {
        why = 'The location request timed out.';
      } else {
        why = `Location failed (${escapeHtml(String((err && err.message) || 'unknown reason'))}).`;
      }
      setHazardLocStatus(
        `${why} Tap <strong>🗺 Pick on map</strong> to place the report yourself` +
        `${codes === 1 ? '' : ', or <strong>📍 Use my location</strong> to try again'}. ` +
        `<span style="color:var(--text-muted)">Nothing is guessed — a report is only ` +
        `placed where you put it.</span>`
      );
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

function hazardOnMapClick(e) {
  if (!hazardPickMode) return;
  hazardDraft.lat = e.latlng.lat;
  hazardDraft.lng = e.latlng.lng;
  hazardDraft.accuracyM = null;
  hazardDraft.source = 'map-pick';
  setHazardPickMode(false);
  setHazardLocStatus(
    `🗺 ${hazardDraft.lat.toFixed(5)}, ${hazardDraft.lng.toFixed(5)} ` +
    `<span style="color:var(--text-dim)">(picked on map)</span>`
  );
}

// Downscale in the browser so the upload stays small and no image dependency is
// needed server-side. ~1280 px longest edge, JPEG q0.75 → typically ~150 KB.
// Support HEIC/HEIF format for iPhone users.
function hazardDownscalePhoto(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const MAX = 1280;
      let { width: w, height: h } = img;
      if (w > MAX || h > MAX) {
        const scale = MAX / Math.max(w, h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.75), w, h });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable image')); };
    img.src = url;
  });
}

// Convert HEIC/HEIF files to JPEG for iPhone compatibility
async function convertHeicToJpeg(file) {
  // Check if the file is HEIC/HEIF
  const fileExt = file.name.toLowerCase().endsWith('.heic') ||
                 file.name.toLowerCase().endsWith('.heif') ||
                 file.type.includes('heic') ||
                 file.type.includes('heif');

  if (!fileExt) {
    // Not a HEIC file, process normally
    return file;
  }

  try {
    // Check if heic-convert library is available (in Node environment)
    // For browser-based HEIC conversion, we'll need a different approach
    // For now, we'll add a more informative error message for HEIC files
    throw new Error('HEIC/HEIF files are not supported in the browser. Please convert to JPEG or PNG using your device\'s photo app before uploading.');
  } catch (error) {
    throw new Error('Failed to process HEIC file: ' + error.message);
  }
}

// Enhanced photo processing that handles HEIC files
async function processPhotoFile(file) {
  // Check for HEIC/HEIF files and provide helpful guidance
  if (file.name.toLowerCase().endsWith('.heic') || file.name.toLowerCase().endsWith('.heif')) {
    // For iPhone users, provide specific guidance
    throw new Error(
      'iPhone photos are saved as HEIC format. To upload them, please:\n\n' +
      '1. Open your Photos app\n' +
      '2. Select the photo you want to upload\n' +
      '3. Tap "Share" → "Copy Photo" or "Save to Files"\n' +
      '4. Open any photo viewer app that converts HEIC to JPEG\n' +
      '5. Save the converted photo to your Camera Roll\n\n' +
      'Alternatively, change iPhone camera settings:\n' +
      'Settings → Camera → Formats → "Most Compatible" (instead of "High Efficiency")'
    );
  }

  // For other file types, proceed with normal processing
  return file;
}

/**
 * Reset the photo to "none attached" — the draft, the real file input, the
 * thumbnail and both status lines.
 *
 * The input's `value` must be cleared explicitly: without it, choosing the same
 * file again fires no `change` event, so a reporter who removed a photo by
 * mistake could not re-attach the same one.
 */
function hazardClearPhoto() {
  hazardDraft.photo = null;
  const input = document.getElementById('hazardPhoto');
  const preview = document.getElementById('hazardPhotoPreview');
  const thumb = document.getElementById('hazardPhotoThumb');
  const status = document.getElementById('hazardPhotoStatus');
  const error = document.getElementById('hazardPhotoError');
  if (input) input.value = '';
  if (preview) preview.hidden = true;
  // Blank the src as well as hiding the block. Hiding alone leaves the previous
  // report's image in the DOM, and this modal is reused for every report — the
  // stale-DOM rule the run-state panel already learned the hard way (§5, and
  // VERIFIED #21 one layer up in the view).
  if (thumb) thumb.removeAttribute('src');
  if (status) status.textContent = '';
  if (error) error.textContent = '';
}

async function hazardOnPhotoChange(ev) {
  const preview = document.getElementById('hazardPhotoPreview');
  const thumb = document.getElementById('hazardPhotoThumb');
  const status = document.getElementById('hazardPhotoStatus');
  const error = document.getElementById('hazardPhotoError');
  const file = ev.target.files && ev.target.files[0];
  hazardDraft.photo = null;
  if (error) error.textContent = '';
  if (!file) { hazardClearPhoto(); return; }

  // Handle HEIC/HEIF files with helpful guidance for iPhone users
  if (file.name.toLowerCase().endsWith('.heic') || file.name.toLowerCase().endsWith('.heif') ||
      file.type.includes('heic') || file.type.includes('heif')) {
    hazardClearPhoto();
    if (error) {
      error.textContent =
        'iPhone photos are saved as HEIC format. To upload them, please convert to JPEG or PNG using your device\'s Photos app or any photo viewer app. ' +
        'Alternatively, change iPhone camera settings to "Most Compatible" format.';
    }
    return;
  }

  if (preview) preview.hidden = false;
  if (thumb) thumb.removeAttribute('src');
  if (status) status.textContent = 'Processing photo…';
  try {
    const { dataUrl, w, h } = await hazardDownscalePhoto(file);
    hazardDraft.photo = dataUrl;
    const kb = Math.round((dataUrl.length * 0.75) / 1024);
    // Show the reporter the image that will actually be sent — the downscaled
    // one, not the original. If the resize mangled the photo, this is the only
    // place they can see that before it becomes scored evidence.
    if (thumb) thumb.src = dataUrl;
    if (status) {
      status.textContent =
        `Photo ready — resized to ${w}×${h}, about ${kb} KB. ` +
        `Resized on your device; the original is never uploaded.`;
    }
  } catch (err) {
    // A failed photo must not block the report: `evidence` is one of five
    // confidence components, not a gate.
    if (preview) preview.hidden = true;
    if (thumb) thumb.removeAttribute('src');
    if (status) status.textContent = '';
    if (error) {
      error.textContent =
        `Could not read that image (${err.message}). You can submit without a photo.`;
    }
  }
}

async function submitHazardReport() {
  const btn = document.getElementById('hazardSubmitBtn');
  const note = document.getElementById('hazardSubmitNote');
  const category = document.getElementById('hazardCategory').value;
  const description = document.getElementById('hazardDescription').value.trim();

  if (hazardDraft.lat == null || hazardDraft.lng == null) {
    if (note) note.innerHTML = `<span style="color:#f87171">Set a location first — a report ` +
      `without coordinates cannot be corroborated or placed on the corridor.</span>`;
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }
  if (note) note.textContent = '';

  try {
    const res = await fetch(apiUrl('/api/hazards'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category, description,
        lat: hazardDraft.lat, lng: hazardDraft.lng,
        accuracyM: hazardDraft.accuracyM,
        locationSource: hazardDraft.source,
        photo: hazardDraft.photo || undefined,
        trainNumber: selectedTrainNumber || undefined,
        clientReportedAt: new Date().toISOString(),
      }),
    });
    const json = await res.json();

    if (!res.ok || !json.success) {
      if (note) {
        note.innerHTML = `<span style="color:#f87171">Could not submit: ` +
          `${escapeHtml(json.detail || json.reason || 'unknown error')}</span>`;
      }
      return;
    }

    // Report back what the SCORE actually was and what happens next. Telling a
    // reporter "thanks, submitted" and nothing else hides the single most
    // important fact: a score does not confirm anything, a controller does.
    const rep = json.data && (json.data.report || json.data);
    const conf = rep && rep.scoring && rep.scoring.confidence;
    const status = rep && rep.status;
    if (note) {
      note.innerHTML =
        `<span style="color:#34d399;font-weight:600">Report logged.</span> ` +
        (conf != null
          ? `Initial confidence <strong>${(conf * 100).toFixed(0)}%</strong> → status ` +
            `<strong>${escapeHtml(status)}</strong>. `
          : '') +
        `It will not affect any ETA until a controller confirms it.`;
    }

    // Refresh the overlay so the new pin appears immediately if the layer is on.
    if (hazardLayerOn) {
      const r2 = await fetch(apiUrl('/api/hazards'));
      const j2 = await r2.json();
      if (j2.success && j2.data) { hazardData = j2.data; renderHazardMarkers(hazardData); }
    }
    setTimeout(closeHazardModal, 2600);
  } catch (err) {
    if (note) note.innerHTML = `<span style="color:#f87171">Network error: ${escapeHtml(err.message)}</span>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Submit report'; }
  }
}

// ── Wiring ──────────────────────────────────────────────────────────────────
// Waits for gati:ready rather than DOMContentLoaded: bootstrapApp() is async, so
// `map` and the layer groups do not exist yet when this file finishes parsing.
// Same contract admin.js uses.
document.addEventListener('gati:ready', () => {
  if (!map) return;
  hazardLayer = L.layerGroup();               // opt-in, like the corridor layer

  const on = (id, ev, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(ev, fn);
  };

  on('hazardToggleBtn', 'click', toggleHazardLayer);
  on('hazardReportBtn', 'click', openHazardModal);
  on('hazardModalClose', 'click', closeHazardModal);
  on('hazardCancelBtn', 'click', closeHazardModal);
  on('hazardSubmitBtn', 'click', submitHazardReport);
  on('hazardUseGpsBtn', 'click', hazardUseGps);
  on('hazardPickMapBtn', 'click', () => setHazardPickMode(!hazardPickMode));
  on('hazardPhoto', 'change', hazardOnPhotoChange);
  on('hazardPhotoRemoveBtn', 'click', hazardClearPhoto);
  on('hazardLegendClose', 'click', () => { if (hazardLayerOn) toggleHazardLayer(); });

  map.on('click', hazardOnMapClick);

  // Dismiss on backdrop click, but not on a click inside the card.
  const modal = document.getElementById('hazardModal');
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeHazardModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (hazardPickMode) { setHazardPickMode(false); return; }
    const m = document.getElementById('hazardModal');
    if (m && !m.hidden) closeHazardModal();
  });
});
