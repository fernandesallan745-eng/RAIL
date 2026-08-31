import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { railRadarService } from '../services/railradar.js';
import { config } from '../config/env.js';
import { cache } from '../middleware/cache.js';
import { enhanceLiveData, getTunnelZones } from '../services/deadReckoning.js';

const FALLBACK_DIR = path.join(process.cwd(), '.cache');
const FALLBACK_FILE = path.join(FALLBACK_DIR, 'fleet_fallback.json');

// Ensure cache folder exists
if (!fs.existsSync(FALLBACK_DIR)) {
  fs.mkdirSync(FALLBACK_DIR, { recursive: true });
}

export const getHealth = (req, res) => {
  // Upstream posture (quota burned, 429 count, scheduler queue depth, active fleet) is
  // surfaced here rather than left in the server logs because with live caching disabled
  // the monthly cap — 1,000 req/key/month — is now the binding constraint, not the cache.
  // "How much budget is left and did we get throttled?" has to be answerable from the
  // browser during the demo, without shelling into the box to read stdout.
  //
  // Guarded on purpose: /health is the endpoint an operator hits precisely *when things
  // are broken*, so it must never be the thing that throws. If the service layer is
  // mid-reload (nodemon) or predates getDiagnostics(), say so instead of returning a 500.
  const upstream = typeof railRadarService.getDiagnostics === 'function'
    ? railRadarService.getDiagnostics()
    : { unavailable: true, reason: 'railRadarService.getDiagnostics() not available' };

  res.json({
    success: true,
    status: 'online',
    serverTime: new Date().toISOString(),
    railRadar: {
      baseUrl: config.railRadar.baseUrl,
      apiKeyConfigured: Boolean(config.railRadar.apiKey && config.railRadar.apiKey.length > 0),
      apiKeyMasked: config.railRadar.apiKey
        ? `${config.railRadar.apiKey.slice(0, 4)}...${config.railRadar.apiKey.slice(-4)}`
        : 'NOT_SET',
    },
    // Raw keys never appear here — only the count, the active index and the masked form
    // above. `upstream.quota.perKey` reports usage positionally for the same reason.
    upstream,
    cache: {
      cachedKeysCount: cache.keys().length,
      liveTtlSeconds: config.cache.liveTtl,
      staticTtlSeconds: config.cache.staticTtl,
      // Authoritative live/static policy (incl. liveCachingDisabled) is upstream.cachePolicy.
      // Not duplicated into this block: two copies of the same state drift.
    },
    // Published so the browser can link to the model service (audit console, OpenAPI docs)
    // without hardcoding a second copy of the port in front-end code.
    modelApi: {
      baseUrl: config.modelApi.baseUrl,
    },
  });
};

export const getTrainSchedule = async (req, res, next) => {
  try {
    const { trainNumber } = req.params;
    if (!trainNumber) {
      return res.status(400).json({ success: false, message: 'Train number is required.' });
    }
    const data = await railRadarService.getTrainSchedule(trainNumber);
    res.json({
      success: true,
      trainNumber,
      data,
    });
  } catch (error) {
    next(error);
  }
};

export const getTrainLiveStatus = async (req, res, next) => {
  const { trainNumber } = req.params;
  if (!trainNumber) {
    return res.status(400).json({ success: false, message: 'Train number is required.' });
  }

  try {
    // 1. Fetch raw live status and route geometry in parallel
    const [liveDataRaw, routeGeoJsonRaw] = await Promise.allSettled([
      railRadarService.getTrainLiveStatus(trainNumber, req.query),
      railRadarService.getTrainRoute(trainNumber)
    ]);

    const liveDataObj = liveDataRaw.status === 'fulfilled' ? liveDataRaw.value : null;
    const routeGeoJson = routeGeoJsonRaw.status === 'fulfilled' ? routeGeoJsonRaw.value : null;

    if (!liveDataObj) {
      // If the primary live status call failed, check if it was due to rate limiting (429)
      const errorReason = liveDataRaw.reason || {};
      if (errorReason.status === 429 || errorReason.response?.status === 429) {
        throw errorReason; // propagate to catch block for cache fallback
      }
      throw new Error(`Failed to fetch live status for train #${trainNumber}`);
    }

    // Extract inner payload depending on nesting structure
    const liveData = liveDataObj.data?.data || liveDataObj.data || liveDataObj;

    // 2. Augment live status with Dead Reckoning tunnel/stale-signal tracking
    const enhancedData = enhanceLiveData(liveData, routeGeoJson);

    // 3. Request curvature/delay-aware ETA from FastAPI server (Port 8000)
    let startDate = liveData.startDate || new Date().toISOString().split('T')[0];
    try {
      const fastApiUrl = `${config.modelApi.baseUrl}/eta/${trainNumber}`;
      try {
        const fastApiRes = await axios.get(fastApiUrl, {
          params: { date: startDate, weather: req.query.weather || 'clear' },
          timeout: 1500,
        });
        if (fastApiRes.data) {
          enhancedData.curvatureEta = fastApiRes.data;
          // When this date has no cache file, FastAPI substitutes another cached
          // run's timings and returns 200 (not 404) with schedule_date_substituted
          // set. Read the flag from the payload — the 404 branch below only fires
          // for an unknown TRAIN, so it never caught an uncached date.
          if (fastApiRes.data.schedule_date_substituted) {
            enhancedData.curvatureEta.is_fallback_date = true;
          }
        }
      } catch (err) {
        if (err.response && err.response.status === 404) {
          console.log(`[FastAPI integration] Train ${trainNumber} not in ETA cache. Fetching fallback...`);
          const healthRes = await axios.get(`${config.modelApi.baseUrl}/health`, { timeout: 1000 });
          const cachedDates = healthRes.data?.cached_dated_runs || [];
          if (cachedDates.length > 0) {
            const fallbackDate = cachedDates[cachedDates.length - 1];
            const fallbackRes = await axios.get(fastApiUrl, {
              params: { date: fallbackDate, weather: req.query.weather || 'clear' },
              timeout: 1500,
            });
            if (fallbackRes.data) {
              enhancedData.curvatureEta = fallbackRes.data;
              enhancedData.curvatureEta.is_fallback_date = true;
            }
          }
        } else {
          throw err;
        }
      }
    } catch (err) {
      console.warn(`[FastAPI integration] Curvature ETA model offline or failed: ${err.message}`);
    }

    // Success path: Persist a copy of the enhanced train status to disk cache
    if (enhancedData) {
      try {
        const trainFile = path.join(FALLBACK_DIR, `train_${trainNumber}_live_fallback.json`);
        fs.writeFileSync(trainFile, JSON.stringify(enhancedData, null, 2), 'utf-8');
      } catch (writeErr) {
        console.error(`[Controller] Failed to write disk fallback for train #${trainNumber}:`, writeErr.message);
      }

      // Stamp the degradation flags on the SUCCESS path too, so they are ALWAYS present.
      // Previously they were set only when the fallback fired, which meant an absent
      // `is_cached_fallback` was ambiguous: it could mean "genuinely live" or "this code
      // path never set it". The front end had no way to tell those apart, so it could not
      // safely claim a position was live. Now absence is impossible on this route and
      // `false` is a real assertion.
      //
      // Deliberately stamped AFTER the disk write above: JSON.stringify already ran, so the
      // persisted copy does not carry is_cached_fallback:false. That matters — the moment
      // that file is re-served it *is* a fallback, and a stale `false` baked into it would
      // be a live-data claim we can't back up. (Inside this guard, not after it, so a null
      // payload can never turn a successful fetch into a thrown TypeError and divert into
      // the fallback branch below.)
      enhancedData.is_cached_fallback = false;
      enhancedData.rate_limit_active = false;
    }

    res.json({
      success: true,
      trainNumber,
      data: enhancedData,
    });
  } catch (error) {
    // ── Last-resort insurance, NOT a cache layer ──
    // Live responses are no longer cached (config.cache.liveTtl = 0, bypassed entirely), so
    // this branch can no longer fire merely because a TTL lapsed. It fires only when upstream
    // genuinely failed: a 429 burst, a timeout, or no network. Keep it — a blank map during
    // the 1 Sep demo is worse than a clearly-labelled stale one.
    // Every response it produces is explicitly labelled (is_cached_fallback /
    // recovered_from_disk / rate_limit_active) so the UI can say "last known position,
    // fetched at <time>" rather than implying a live GPS fix. Do not remove the labels to
    // make the map look cleaner; that turns insurance into a false liveness claim.
    console.warn(`[Controller] Upstream live status call failed for train #${trainNumber}: ${error.message}. Checking cache...`);

    // 1. Check in-memory cache keys first.
    //    NOTE: with live caching disabled these keys are never populated any more, so in
    //    practice this loop no-ops and the disk copy below is the insurance that actually
    //    fires. Left in place because it costs nothing and still works if CACHE_TTL_LIVE is
    //    deliberately set back to a non-zero value (e.g. to rehearse offline).
    const baseUri = `/api/trains/${trainNumber}/live`;
    const cacheKeys = [
      `__cache__${baseUri}?geometry=true&geometry_format=geojson`,
      `__cache__${baseUri}?geometry=true&geometry_format=geojson&refresh=true`,
      `__cache__${baseUri}`,
    ];

    for (const key of cacheKeys) {
      const cached = cache.get(key);
      if (cached && (cached.data || cached.success)) {
        console.log(`[Controller] Recovered in-memory cached status from key "${key}" for train #${trainNumber}`);
        const payload = cached.data || cached;
        payload.is_cached_fallback = true;
        payload.rate_limit_active = (error.status === 429 || error.response?.status === 429);
        return res.json({
          success: true,
          trainNumber,
          data: payload,
        });
      }
    }

    // 2. Check disk-persisted fallback copies next (the branch that actually fires now that
    //    live caching is off — it also survives a server restart, which node-cache does not).
    //    We check multiple naming variations in the .cache folder
    let fallbackDataRaw = null;
    let fallbackPath = '';

    const pathsToCheck = [
      path.join(FALLBACK_DIR, `train_${trainNumber}_live_fallback.json`),
      path.join(FALLBACK_DIR, `${trainNumber}_live.json`),
    ];

    // Also look for dated runs (e.g. 22229_live_2026-08-28.json)
    try {
      const files = fs.readdirSync(FALLBACK_DIR);
      const datedFiles = files
        .filter(f => f.startsWith(`${trainNumber}_live_`) && f.endsWith('.json'))
        .sort(); // latest date will be last
      if (datedFiles.length > 0) {
        pathsToCheck.push(path.join(FALLBACK_DIR, datedFiles[datedFiles.length - 1]));
      }
    } catch (dirErr) {
      console.warn('[Controller] Failed to read fallback dir:', dirErr.message);
    }

    for (const fpath of pathsToCheck) {
      if (fs.existsSync(fpath)) {
        try {
          fallbackDataRaw = JSON.parse(fs.readFileSync(fpath, 'utf-8'));
          fallbackPath = fpath;
          break; // found one!
        } catch (e) {
          console.warn(`[Controller] Failed to parse fallback at ${fpath}:`, e.message);
        }
      }
    }

    if (fallbackDataRaw) {
      console.log(`[Controller] Recovered disk-persisted cached status from ${fallbackPath} for train #${trainNumber}`);
      
      const liveData = fallbackDataRaw.data?.data || fallbackDataRaw.data || fallbackDataRaw;
      
      // Attempt to load route geometry for DR enhancement
      let routeGeoJson = null;
      const routePath = path.join(FALLBACK_DIR, `${trainNumber}_route.json`);
      if (fs.existsSync(routePath)) {
        try {
          routeGeoJson = JSON.parse(fs.readFileSync(routePath, 'utf-8'));
        } catch (e) {}
      }

      // Apply DR and curvature engine processing on the fallback data
      const enhancedData = enhanceLiveData(liveData, routeGeoJson);
      enhancedData.is_cached_fallback = true;
      enhancedData.recovered_from_disk = true;
      enhancedData.rate_limit_active = (error.status === 429 || error.response?.status === 429);

      // Attach curvature ETA model if available
      const startDate = liveData.startDate || new Date().toISOString().split('T')[0];
      try {
        const fastApiUrl = `${config.modelApi.baseUrl}/eta/${trainNumber}`;
        const fastApiRes = await axios.get(fastApiUrl, {
          params: { date: startDate, weather: req.query.weather || 'clear' },
          timeout: 1500,
        });
        if (fastApiRes.data) {
          enhancedData.curvatureEta = fastApiRes.data;
          // Same substitution flag as the live path above.
          if (fastApiRes.data.schedule_date_substituted) {
            enhancedData.curvatureEta.is_fallback_date = true;
          }
        }
      } catch (err) {
        // Fallback date query to FastAPI health check
        try {
          const healthRes = await axios.get(`${config.modelApi.baseUrl}/health`, { timeout: 1000 });
          const cachedDates = healthRes.data?.cached_dated_runs || [];
          if (cachedDates.length > 0) {
            const fallbackDate = cachedDates[cachedDates.length - 1];
            const fallbackRes = await axios.get(`${config.modelApi.baseUrl}/eta/${trainNumber}`, {
              params: { date: fallbackDate, weather: req.query.weather || 'clear' },
              timeout: 1500,
            });
            if (fallbackRes.data) {
              enhancedData.curvatureEta = fallbackRes.data;
              enhancedData.curvatureEta.is_fallback_date = true;
            }
          }
        } catch (subErr) {}
      }

      return res.json({
        success: true,
        trainNumber,
        data: enhancedData,
      });
    }
    
    // No cache found: propagate the error
    next(error);
  }
};

export const getTunnels = async (req, res, next) => {
  try {
    const zones = getTunnelZones();
    res.json({
      success: true,
      data: zones,
    });
  } catch (error) {
    next(error);
  }
};

export const getTrainRoute = async (req, res, next) => {
  try {
    const { trainNumber } = req.params;
    if (!trainNumber) {
      return res.status(400).json({ success: false, message: 'Train number is required.' });
    }
    const data = await railRadarService.getTrainRoute(trainNumber);
    res.json({
      success: true,
      trainNumber,
      data,
    });
  } catch (error) {
    next(error);
  }
};

export const getTrainCoaches = async (req, res, next) => {
  try {
    const { trainNumber } = req.params;
    if (!trainNumber) {
      return res.status(400).json({ success: false, message: 'Train number is required.' });
    }
    const data = await railRadarService.getTrainCoaches(trainNumber);
    res.json({
      success: true,
      trainNumber,
      data,
    });
  } catch (error) {
    next(error);
  }
};

export const searchTrains = async (req, res, next) => {
  try {
    const query = req.query.q || req.query.query || req.query.search;
    if (!query) {
      return res.status(400).json({
        success: false,
        message: 'Search query is required. Provide ?q=12002 or ?q=Shatabdi',
      });
    }
    const data = await railRadarService.searchTrains(query);
    res.json({
      success: true,
      query,
      data,
    });
  } catch (error) {
    next(error);
  }
};

export const getTrainCategories = async (req, res, next) => {
  try {
    const data = await railRadarService.getTrainCategories();
    res.json({
      success: true,
      data,
    });
  } catch (error) {
    next(error);
  }
};

export const getLiveFleet = async (req, res, next) => {
  try {
    const data = await railRadarService.getLiveFleet();
    
    // If the fleet fetch returned 0 trains (upstream refused every request, or the quota
    // guard is holding the line), fall back to the last successfully cached fleet copy so the
    // dashboard doesn't go blank. Insurance only — with live caching disabled this cannot
    // fire from a lapsed TTL, only from genuine upstream failure — and every branch below
    // labels its response is_cached_fallback:true so the UI can mark the markers as stale.
    if (!data || !data.fleet || data.fleet.length === 0) {
      console.warn('[LiveFleet Controller] Upstream returned empty fleet. Fetching fallback cache...');
      
      // 1. Try In-Memory Cache first
      const cacheKeys = [
        '__cache__/api/trains/radar/fleet',
        '__cache__/api/trains/radar/fleet?refresh=true',
      ];
      for (const key of cacheKeys) {
        const cached = cache.get(key);
        const cachedFleet = cached?.data?.fleet || cached?.fleet;
        if (cachedFleet && cachedFleet.length > 0) {
          console.log(`[LiveFleet Controller] Recovered in-memory cached fleet from key "${key}"`);
          return res.json({
            success: true,
            data: {
              count: cachedFleet.length,
              timestamp: cached?.data?.timestamp || cached?.timestamp || new Date().toISOString(),
              fleet: cachedFleet,
              is_cached_fallback: true,
              // Why the LIVE attempt produced nothing. Without this the fallback is
              // indistinguishable from success and a persistent live failure hides
              // behind slightly-old positions.
              live_failures: data?.failures || [],
              requested: data?.requested ?? null,
            }
          });
        }
      }

      // 2. Try Disk Fallback Cache next (survives server restarts)
      if (fs.existsSync(FALLBACK_FILE)) {
        try {
          const diskPayload = JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf-8'));
          if (diskPayload && diskPayload.fleet && diskPayload.fleet.length > 0) {
            console.log(`[LiveFleet Controller] Recovered disk-persisted cached fleet from ${FALLBACK_FILE}`);
            return res.json({
              success: true,
              data: {
                count: diskPayload.fleet.length,
                timestamp: diskPayload.timestamp || new Date().toISOString(),
                fleet: diskPayload.fleet,
                is_cached_fallback: true,
                recovered_from_disk: true,
                // See the in-memory branch: the live attempt's failure reasons must
                // travel with the fallback, or the fallback looks like success.
                live_failures: data?.failures || [],
                requested: data?.requested ?? null,
              }
            });
          }
        } catch (readErr) {
          console.error('[LiveFleet Controller] Failed to read disk fallback:', readErr.message);
        }
      }
    }

    // Success path: Persist a copy to disk cache
    if (data && data.fleet && data.fleet.length > 0) {
      try {
        fs.writeFileSync(FALLBACK_FILE, JSON.stringify(data, null, 2), 'utf-8');
      } catch (writeErr) {
        console.error('[LiveFleet Controller] Failed to write fallback file to disk:', writeErr.message);
      }
    }

    // Symmetry with getTrainLiveStatus: an absent is_cached_fallback must never be the only
    // evidence that the fleet is live, so assert it explicitly. Stamped after the disk write
    // for the same reason as there — the persisted copy is a fallback by definition and must
    // not carry a baked-in `false`.
    // An empty-but-live fleet legitimately reaches here with false: that is honest (upstream
    // answered, nothing is running), and distinct from serving yesterday's positions.
    if (data) {
      data.is_cached_fallback = false;
    }

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    next(error);
  }
};

export const proxyPass = async (req, res, next) => {
  try {
    // subpath extracted from wildcard
    const subpath = req.params[0] || '';
    if (!subpath) {
      return res.status(400).json({
        success: false,
        message: 'Wildcard subpath is missing. Example: /api/proxy/trains/12002/live',
      });
    }
    const data = await railRadarService.proxyRequest(subpath, req.method, req.query, req.body);
    res.json({
      success: true,
      path: subpath,
      data,
    });
  } catch (error) {
    next(error);
  }
};
