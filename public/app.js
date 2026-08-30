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

// Cache TTL config (milliseconds)
const CACHE_TTL = {
  fleet: 60 * 1000,              // 60 seconds (fleet refreshes every minute)
  trainLive: 20 * 1000,          // 20 seconds (selected train refreshes every 20s)
  trainRoute: 24 * 60 * 60 * 1000, // 24 hours (static geometry)
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
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  loadLiveFleet();
  setupSearch();
  setupEventListeners();
  startAutoRefresh();
  startLiveClock();
});

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

  // Layer 1: Satellite Hybrid (Esri World Imagery + Labels)
  const esriSatellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
      maxZoom: 18,
    }
  );

  const esriLabels = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    {
      attribution: '',
      maxZoom: 18,
      opacity: 0.85,
    }
  );

  satelliteLayersGroup = L.layerGroup([esriSatellite, esriLabels]);

  // Layer 2: CartoDB Dark Matter
  darkLayersGroup = L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    {
      attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
      maxZoom: 18,
      subdomains: 'abcd',
    }
  );

  // Layer 3: OpenRailwayMap overlay (Track lines)
  railwayLayer = L.tileLayer(
    'https://{s}.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png',
    {
      maxZoom: 18,
      opacity: 0.45,
      attribution: '&copy; <a href="https://www.openrailwaymap.org/">OpenRailwayMap</a>',
    }
  );

  // Default to Satellite View matching RailRadar
  satelliteLayersGroup.addTo(map);
  railwayLayer.addTo(map);

  // Layers for features
  fleetMarkersLayer = L.layerGroup().addTo(map);
  activeRouteLayer = L.layerGroup().addTo(map);
  activeStationsLayer = L.layerGroup().addTo(map);
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
    btn.style.backgroundImage = "url('https://a.basemaps.cartocdn.com/dark_all/4/11/7.png')";
  } else {
    map.removeLayer(darkLayersGroup);
    satelliteLayersGroup.addTo(map);
    currentLayer = 'satellite';
    label.innerText = 'Satellite';
    btn.style.backgroundImage = "url('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/4/7/11')";
  }
}

// Load Fleet Data from Backend (Protected with TTL-based Cache)
async function loadLiveFleet(forceRefresh = false) {
  const fleetPill = document.getElementById('fleetStatusText');
  const now = Date.now();

  // If already in client cache and less than TTL old, reuse (unless forced)
  if (!forceRefresh && clientCache.fleet && now - clientCache.fleetTime < CACHE_TTL.fleet) {
    renderFleetMarkers(clientCache.fleet);
    return;
  }

  try {
    const url = forceRefresh ? '/api/trains/radar/fleet?refresh=true' : '/api/trains/radar/fleet';
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
          <span>Speed: ${Math.round(train.speed || 60)} km/h</span>
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
async function selectTrain(trainNumber, forceRefresh = false) {
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
      const url = `/api/trains/${trainNumber}/live?geometry=true&geometry_format=geojson${forceRefresh ? '&refresh=true' : ''}`;
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
        const res = await fetch(`/api/trains/${trainNumber}/route`);
        const json = await res.json();
        routeGeoJson = json.data?.data || json.data;
      }
      if (routeGeoJson) clientCache.trainRoute.set(trainNumber, routeGeoJson);
    }

    // 3. Fetch coaches (long-lived cache — 24h)
    let coachesData = clientCache.trainCoaches.get(trainNumber);
    if (!coachesData) {
      const res = await fetch(`/api/trains/${trainNumber}/coaches`);
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
    
    // Parse if it was a rate limit error
    const isRateLimit = err.message.toLowerCase().includes('rate limit') || err.message.toLowerCase().includes('429');
    const msg = isRateLimit 
      ? '⚠️ Upstream rate limit. Displaying cached telemetry.'
      : `⚠️ Error: ${err.message}`;
      
    document.getElementById('drawerTrainName').innerHTML = `<span style="color: #fbbf24; font-weight: 700; font-size: 0.85rem;">${msg}</span>`;
    
    // Try to recover any cached data from in-memory cache to render what we can
    const cachedLive = clientCache.trainLive.get(trainNumber);
    const cachedCoaches = clientCache.trainCoaches.get(trainNumber);
    const cachedRoute = clientCache.trainRoute.get(trainNumber);
    
    if (cachedLive) {
      renderTrainOnMap(cachedLive, cachedRoute, true);
      renderTrainDrawer(cachedLive, cachedCoaches);
      document.getElementById('drawerTrainName').innerHTML = `<span style="color: #fbbf24; font-weight: 700; font-size: 0.85rem;">⚠️ Rate Limited (Showing Cache)</span>`;
    } else {
      stopTrainAutoRefresh();
    }
  }
}

// Draw Track and Stations on Map
function renderTrainOnMap(liveData, routeGeoJson, skipFlyTo = false) {
  activeRouteLayer.clearLayers();
  activeStationsLayer.clearLayers();

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

    // Fit map bounds smoothly (skip on auto-refresh to avoid jarring the view)
    if (!skipFlyTo) {
      map.flyToBounds(coreLine.getBounds(), {
        padding: [60, 60],
        duration: 1.2,
      });
    }
  }

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

  // 📡 Dead Reckoning Panel UI Integration
  const drPanel = document.getElementById('deadReckoningPanel');
  const drBadge = document.getElementById('drawerDrBadge');
  const drInfo = liveData.deadReckoning;

  if (drInfo && drInfo.active) {
    drBadge.style.display = 'block';
    drPanel.style.display = 'block';
    
    document.getElementById('drTunnelName').innerText = drInfo.tunnelZone?.name || 'Unnamed Tunnel';
    const staleSecs = Math.round(drInfo.staleSinceMs / 1000);
    const staleStr = staleSecs < 60 ? `${staleSecs}s ago` : `${Math.floor(staleSecs / 60)}m ago`;
    document.getElementById('drLastSignal').innerText = `${staleStr} (${new Date(drInfo.lastSignalAt).toLocaleTimeString('en-IN')})`;
    
    const estPos = drInfo.estimatedPosition;
    document.getElementById('drEstPos').innerText = `${estPos.lat.toFixed(4)}°, ${estPos.lng.toFixed(4)}° (${estPos.distanceFromEntryKm.toFixed(2)} km in)`;
    document.getElementById('drConfidence').innerText = `${Math.round(estPos.confidence * 100)}%`;
  } else {
    drBadge.style.display = 'none';
    drPanel.style.display = 'none';
  }

  // 🧠 Curvature & Delay-Aware ETA Engine Panel UI Integration
  const etaPanel = document.getElementById('curvatureEtaPanel');
  const cEta = liveData.curvatureEta;

  if (cEta) {
    etaPanel.style.display = 'block';

    const segments = cEta.segments || [];
    // Compute summary metrics from segment details
    const activeSegIndex = Math.min(
      currentLoc.sequence ? currentLoc.sequence - 1 : 0,
      segments.length - 1
    );
    const activeSeg = segments[activeSegIndex] || {};

    const sharpestR = cEta.sharpest_radius_m || activeSeg.min_radius_m || 'N/A';
    const curveSpd = cEta.sharpest_capped_speed_kmh || activeSeg.curve_capped_speed_kmh || '80';
    document.getElementById('etaSharpestCurve').innerText = sharpestR !== 'N/A' 
      ? `R=${sharpestR}m (${curveSpd} km/h)` 
      : 'No curve cap';

    const weatherVal = cEta.weather || 'clear';
    const weatherCapVal = activeSeg.weather_capped_speed_kmh || '80';
    document.getElementById('etaWeatherCap').innerText = `${weatherVal.toUpperCase()} (${weatherCapVal} km/h)`;

    const totalSlack = segments.reduce((sum, s) => sum + (s.schedule_slack_min || 0), 0);
    document.getElementById('etaScheduleSlack').innerText = `${totalSlack.toFixed(1)} min`;

    const totalHistDelay = segments.reduce((sum, s) => sum + (s.hist_delay_min || 0), 0);
    document.getElementById('etaHistDelay').innerText = `+${totalHistDelay.toFixed(1)} min`;

    const totalPred = cEta.total_predicted_min || segments.reduce((sum, s) => sum + (s.segment_eta_min || 0), 0);
    const totalSched = cEta.actual_scheduled_min || 635;
    document.getElementById('etaEnginePrediction').innerText = `${totalPred.toFixed(1)} min (vs ${totalSched} min Sched)`;
  } else {
    etaPanel.style.display = 'none';
  }

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
  document.getElementById('deadReckoningPanel').style.display = 'none';
  document.getElementById('curvatureEtaPanel').style.display = 'none';
  
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
        const res = await fetch(`/api/trains/search?q=${encodeURIComponent(val)}`);
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

/** Start the fleet radar auto-refresh (every 5 min) */
function startAutoRefresh() {
  if (fleetRefreshInterval) clearInterval(fleetRefreshInterval);
  fleetRefreshInterval = setInterval(() => {
    console.log('[Live] Auto-refreshing fleet radar...');
    loadLiveFleet(true);
  }, CACHE_TTL.fleet);
}

/** Start auto-refreshing a selected train (every 60s) */
function startTrainAutoRefresh(trainNumber) {
  stopTrainAutoRefresh();
  trainRefreshInterval = setInterval(() => {
    if (selectedTrainNumber === trainNumber) {
      console.log(`[Live] Auto-refreshing train #${trainNumber}...`);
      selectTrain(trainNumber, true);
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
