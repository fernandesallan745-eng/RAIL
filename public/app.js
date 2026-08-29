// RailRadar Live Map Engine
const clientCache = {
  fleet: null,
  fleetTime: 0,
  trainLive: new Map(),
  trainRoute: new Map(),
  trainCoaches: new Map(),
  searches: new Map(),
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

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  loadLiveFleet();
  setupSearch();
  setupEventListeners();
});

// Map Initialization
function initMap() {
  // Center map on India
  map = L.map('map', {
    center: [21.7679, 78.8718],
    zoom: 5,
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

// Load Fleet Data from Backend (Protected with 5 min Cache)
async function loadLiveFleet() {
  const fleetPill = document.getElementById('fleetStatusText');
  const now = Date.now();

  // If already in client cache and less than 5 min old, reuse
  if (clientCache.fleet && now - clientCache.fleetTime < 300000) {
    renderFleetMarkers(clientCache.fleet);
    return;
  }

  try {
    const res = await fetch('/api/trains/radar/fleet');
    const json = await res.json();
    if (json.success && json.data?.fleet) {
      clientCache.fleet = json.data.fleet;
      clientCache.fleetTime = now;
      renderFleetMarkers(json.data.fleet);
      if (fleetPill) {
        fleetPill.innerText = `${json.data.fleet.length} Trains Live on Radar`;
      }
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
async function selectTrain(trainNumber) {
  selectedTrainNumber = trainNumber;
  openDrawerLoading(trainNumber);

  try {
    // 1. Fetch live status (cached in clientCache if available)
    let liveData = clientCache.trainLive.get(trainNumber);
    if (!liveData) {
      const res = await fetch(`/api/trains/${trainNumber}/live`);
      const json = await res.json();
      liveData = json.data?.data || json.data;
      if (liveData) clientCache.trainLive.set(trainNumber, liveData);
    }

    // 2. Fetch route geometry (cached in clientCache)
    let routeGeoJson = clientCache.trainRoute.get(trainNumber);
    if (!routeGeoJson) {
      const res = await fetch(`/api/trains/${trainNumber}/route`);
      const json = await res.json();
      routeGeoJson = json.data?.data || json.data;
      if (routeGeoJson) clientCache.trainRoute.set(trainNumber, routeGeoJson);
    }

    // 3. Fetch coaches (cached in clientCache)
    let coachesData = clientCache.trainCoaches.get(trainNumber);
    if (!coachesData) {
      const res = await fetch(`/api/trains/${trainNumber}/coaches`);
      const json = await res.json();
      coachesData = json.data?.data || json.data;
      if (coachesData) clientCache.trainCoaches.set(trainNumber, coachesData);
    }

    if (liveData) {
      renderTrainOnMap(liveData, routeGeoJson);
      renderTrainDrawer(liveData, coachesData);
    }
  } catch (err) {
    console.error('Failed to load train details:', err);
    alert(`Could not load live details for train #${trainNumber}.`);
  }
}

// Draw Track and Stations on Map
function renderTrainOnMap(liveData, routeGeoJson) {
  activeRouteLayer.clearLayers();
  activeStationsLayer.clearLayers();

  const trainInfo = liveData.train || {};
  const currentLoc = liveData.currentLocation || {};
  const routeStations = liveData.route || [];

  let coordinates = [];

  // If GeoJSON coordinates exist, use them
  if (routeGeoJson && routeGeoJson.geometry && routeGeoJson.geometry.coordinates) {
    coordinates = routeGeoJson.geometry.coordinates.map(c => [c[1], c[0]]);
  } else if (routeStations.length > 0) {
    // Fallback to station coordinates
    coordinates = routeStations
      .filter(s => s.lat || (s.station && s.station.lat))
      .map(s => [s.lat || s.station.lat, s.lng || s.station.lng]);
  }

  if (coordinates.length > 0) {
    // Outer glowing track line
    const glowLine = L.polyline(coordinates, {
      color: '#38bdf8',
      weight: 6,
      opacity: 0.35,
      lineCap: 'round',
    });

    // Inner sharp track line
    const coreLine = L.polyline(coordinates, {
      color: '#0284c7',
      weight: 3,
      opacity: 0.95,
      lineCap: 'round',
    });

    activeRouteLayer.addLayer(glowLine);
    activeRouteLayer.addLayer(coreLine);

    // Fit map bounds smoothly
    map.flyToBounds(coreLine.getBounds(), {
      padding: [60, 60],
      duration: 1.2,
    });
  }

  // Plot Station Halts
  let currentTrainLat = null;
  let currentTrainLng = null;

  routeStations.forEach((s) => {
    const lat = s.lat || (s.station && s.station.lat);
    const lng = s.lng || (s.station && s.station.lng);
    if (!lat || !lng) return;

    const isPassed = s.status === 'departed' || s.status === 'arrived';
    const isCurrent = s.sequence === currentLoc.sequence || s.status === 'current';

    if (isCurrent || (!currentTrainLat && isPassed)) {
      currentTrainLat = lat;
      currentTrainLng = lng;
    }

    // Station Circle Marker
    if (s.isHalt) {
      const circleMarker = L.circleMarker([lat, lng], {
        radius: isCurrent ? 7 : (isPassed ? 5 : 4),
        fillColor: isCurrent ? '#06b6d4' : (isPassed ? '#10b981' : '#94a3b8'),
        color: '#ffffff',
        weight: 1.5,
        opacity: 1,
        fillOpacity: 0.9,
      });

      circleMarker.bindTooltip(`
        <div style="font-weight: 700; font-size: 0.75rem;">${s.stationName || s.stationCode}</div>
        <div style="font-size: 0.7rem; color: #94a3b8;">${s.actualArrival || s.scheduledArrival || ''}</div>
      `, { direction: 'top', offset: [0, -6] });

      activeStationsLayer.addLayer(circleMarker);
    }
  });

  // Pulse marker for active train location
  if (currentTrainLat && currentTrainLng) {
    const trainPulseIcon = L.divIcon({
      className: 'train-map-marker',
      html: `
        <div class="train-marker-body vande" style="width: 18px; height: 18px; border-width: 3px;">
          <div class="train-marker-pulse" style="border-color: #ec4899;"></div>
        </div>
      `,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });

    const activeMarker = L.marker([currentTrainLat, currentTrainLng], { icon: trainPulseIcon });
    activeMarker.bindPopup(`
      <div class="train-popup-card">
        <div class="popup-train-num">🚄 #${liveData.trainNumber}</div>
        <div class="popup-train-name">${liveData.trainName}</div>
        <div style="color: #34d399; font-size: 0.75rem; font-weight: 700;">
          ${currentLoc.stationName ? 'At ' + currentLoc.stationName : 'En Route'}
        </div>
      </div>
    `);

    activeStationsLayer.addLayer(activeMarker);
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

    const delay = s.delayDeparture ?? s.delayArrival ?? 0;
    const delayHtml = delay > 0 ? `<div class="time-delay-tag">+${delay}m</div>` : '';

    const scheduledTime = s.scheduledArrival || s.scheduledDeparture || '--:--';
    const timeStr = scheduledTime.includes('T') ? scheduledTime.split('T')[1].slice(0, 5) : scheduledTime;

    item.innerHTML = `
      <div class="timeline-dot"></div>
      <div>
        <div class="station-title">${s.stationName || s.stationCode}</div>
        <div class="station-meta-sub">Platform ${s.platform || '1'} &bull; ${s.distance || 0} km</div>
      </div>
      <div class="station-time-col">
        <div class="time-actual">${timeStr}</div>
        ${delayHtml}
      </div>
    `;

    list.appendChild(item);
  });
}

function openDrawerLoading(num) {
  const drawer = document.getElementById('trainDrawer');
  document.getElementById('drawerTrainNum').innerText = `#${num}`;
  document.getElementById('drawerTrainName').innerText = 'Loading train telemetry...';
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
    map.flyTo([21.7679, 78.8718], 5, { duration: 1 });
  });

  document.getElementById('fullscreenBtn').addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });

  document.getElementById('drawerCloseBtn').addEventListener('click', closeDrawer);
}
