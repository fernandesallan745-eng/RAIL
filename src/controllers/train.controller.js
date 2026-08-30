import axios from 'axios';
import { railRadarService } from '../services/railradar.js';
import { config } from '../config/env.js';
import { cache } from '../middleware/cache.js';
import { enhanceLiveData, getTunnelZones } from '../services/deadReckoning.js';

export const getHealth = (req, res) => {
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
    cache: {
      cachedKeysCount: cache.keys().length,
      liveTtlSeconds: config.cache.liveTtl,
      staticTtlSeconds: config.cache.staticTtl,
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
  try {
    const { trainNumber } = req.params;
    if (!trainNumber) {
      return res.status(400).json({ success: false, message: 'Train number is required.' });
    }

    // 1. Fetch raw live status and route geometry in parallel
    const [liveDataRaw, routeGeoJsonRaw] = await Promise.allSettled([
      railRadarService.getTrainLiveStatus(trainNumber, req.query),
      railRadarService.getTrainRoute(trainNumber)
    ]);

    const liveDataObj = liveDataRaw.status === 'fulfilled' ? liveDataRaw.value : null;
    const routeGeoJson = routeGeoJsonRaw.status === 'fulfilled' ? routeGeoJsonRaw.value : null;

    if (!liveDataObj) {
      throw new Error(`Failed to fetch live status for train #${trainNumber}`);
    }

    // Extract inner payload depending on nesting structure
    const liveData = liveDataObj.data?.data || liveDataObj.data || liveDataObj;

    // 2. Augment live status with Dead Reckoning tunnel/stale-signal tracking
    const enhancedData = enhanceLiveData(liveData, routeGeoJson);

    // 3. Request curvature/delay-aware ETA from FastAPI server (Port 8000)
    //    We match the date from the live response (startDate).
    //    If the date is not cached, we query the health endpoint to find the latest
    //    available cached date and use that as a fallback.
    let startDate = liveData.startDate || new Date().toISOString().split('T')[0];
    try {
      const fastApiUrl = `http://127.0.0.1:8000/eta/${trainNumber}`;
      try {
        const fastApiRes = await axios.get(fastApiUrl, {
          params: { date: startDate, weather: req.query.weather || 'clear' },
          timeout: 1500,
        });
        if (fastApiRes.data) {
          enhancedData.curvatureEta = fastApiRes.data;
        }
      } catch (err) {
        // If 404, the date is not cached. Try finding a fallback date from health check.
        if (err.response && err.response.status === 404) {
          console.log(`[FastAPI integration] Date ${startDate} not cached. Fetching fallback...`);
          const healthRes = await axios.get('http://127.0.0.1:8000/health', { timeout: 1000 });
          const cachedDates = healthRes.data?.cached_dated_runs || [];
          if (cachedDates.length > 0) {
            // Pick the latest available date
            const fallbackDate = cachedDates[cachedDates.length - 1];
            console.log(`[FastAPI integration] Falling back to latest cached date: ${fallbackDate}`);
            const fallbackRes = await axios.get(fastApiUrl, {
              params: { date: fallbackDate, weather: req.query.weather || 'clear' },
              timeout: 1500,
            });
            if (fallbackRes.data) {
              enhancedData.curvatureEta = fallbackRes.data;
              // Make sure to reflect that we are showing a modeled fallback date
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

    res.json({
      success: true,
      trainNumber,
      data: enhancedData,
    });
  } catch (error) {
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
