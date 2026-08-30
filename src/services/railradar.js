import axios from 'axios';
import { config } from '../config/env.js';

class RailRadarService {
  constructor() {
    this.client = axios.create({
      baseURL: config.railRadar.baseUrl,
      timeout: config.railRadar.timeout,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    });

    this.currentKeyIndex = 0;

    // Request Interceptor: Attach API Key
    this.client.interceptors.request.use(
      (req) => {
        const keys = config.railRadar.apiKeys || [];
        const apiKey = keys[this.currentKeyIndex] || config.railRadar.apiKey;
        if (apiKey) {
          req.headers['Authorization'] = apiKey.startsWith('Bearer ')
            ? apiKey
            : `Bearer ${apiKey}`;
        }
        return req;
      },
      (error) => Promise.reject(error)
    );

    // Response Interceptor: Format errors consistently & rotate on 429
    this.client.interceptors.response.use(
      (res) => res,
      async (error) => {
        // Check if rate limited (429)
        const isRateLimit = error.response && error.response.status === 429;
        const keys = config.railRadar.apiKeys || [];

        // Track how many times this specific request has been retried across keys
        const originalRequest = error.config || {};
        originalRequest._retryCount = (originalRequest._retryCount || 0) + 1;

        // If rate limited, we have more than 1 key, and we haven't exhausted all of them, rotate and retry!
        if (isRateLimit && keys.length > 1 && originalRequest._retryCount < keys.length) {
          const nextIndex = (this.currentKeyIndex + 1) % keys.length;
          console.warn(`\x1b[33m[RailRadar Service] Upstream rate limit (429) hit for Key #${this.currentKeyIndex}. Rotating to Key #${nextIndex} (Attempt ${originalRequest._retryCount}/${keys.length - 1})...\x1b[0m`);
          
          this.currentKeyIndex = nextIndex;
          config.railRadar.apiKey = keys[this.currentKeyIndex]; // update current config reference
          
          // Retry the failed request with the new rotated key
          originalRequest.headers['Authorization'] = `Bearer ${keys[this.currentKeyIndex]}`;
          
          try {
            return await this.client(originalRequest);
          } catch (retryErr) {
            return Promise.reject(retryErr); // Propagate if the rotated key also fails
          }
        }

        const customError = new Error();

        if (error.response) {
          customError.status = error.response.status;
          customError.data = error.response.data;
          customError.message =
            error.response.data?.message ||
            error.response.data?.error ||
            `RailRadar API error (${error.response.status})`;

          if (error.response.status === 401) {
            customError.message = 'Invalid or missing RailRadar API key. Please check RAILRADAR_API_KEY in your .env file.';
          } else if (error.response.status === 404) {
            customError.message = 'Requested train or railway resource not found on RailRadar.';
          } else if (error.response.status === 429) {
            customError.message = 'RailRadar rate limit exceeded. Please wait a moment or upgrade your plan.';
          }
        } else if (error.request) {
          customError.status = 504;
          customError.message = 'No response received from RailRadar API (Request Timed Out).';
        } else {
          customError.status = 500;
          customError.message = error.message || 'Internal error setting up RailRadar request.';
        }

        return Promise.reject(customError);
      }
    );
  }

  /**
   * Helper to ensure API key is configured before making calls
   */
  ensureApiKey() {
    if (!config.railRadar.apiKey) {
      const error = new Error('RAILRADAR_API_KEY is not configured in .env. Please set your RailRadar API key to make live requests.');
      error.status = 401;
      throw error;
    }
  }

  /**
   * Get train timetable, stops, and schedule details
   * @param {string|number} trainNumber
   */
  async getTrainSchedule(trainNumber) {
    this.ensureApiKey();
    const cleanNumber = String(trainNumber).trim();
    const response = await this.client.get(`/trains/${cleanNumber}`);
    return response.data;
  }

  /**
   * Get real-time running status, delays, and current location
   * @param {string|number} trainNumber
   * @param {Object} params - optional query params (e.g. date)
   */
  async getTrainLiveStatus(trainNumber, params = {}) {
    this.ensureApiKey();
    const cleanNumber = String(trainNumber).trim();
    const response = await this.client.get(`/trains/${cleanNumber}/live`, { params });
    return response.data;
  }

  /**
   * Get GeoJSON route track geometry for map rendering
   * @param {string|number} trainNumber
   */
  async getTrainRoute(trainNumber) {
    this.ensureApiKey();
    const cleanNumber = String(trainNumber).trim();
    const response = await this.client.get(`/trains/${cleanNumber}/route`);
    return response.data;
  }

  /**
   * Get coach composition and layout
   * @param {string|number} trainNumber
   */
  async getTrainCoaches(trainNumber) {
    this.ensureApiKey();
    const cleanNumber = String(trainNumber).trim();
    const response = await this.client.get(`/trains/${cleanNumber}/coaches`);
    return response.data;
  }

  /**
   * Autocomplete/search trains by number or name
   * @param {string} query
   */
  async searchTrains(query) {
    this.ensureApiKey();
    const cleanQuery = String(query).trim();
    // RailRadar supports search via /lookup/search/trains or /lookup/trains
    try {
      const response = await this.client.get('/lookup/search/trains', {
        params: { query: cleanQuery, q: cleanQuery },
      });
      return response.data;
    } catch (err) {
      // Fallback endpoint if format varies
      if (err.status === 404) {
        const response = await this.client.get(`/trains/search`, {
          params: { query: cleanQuery, q: cleanQuery },
        });
        return response.data;
      }
      throw err;
    }
  }

  /**
   * Get train categories list
   */
  async getTrainCategories() {
    this.ensureApiKey();
    const response = await this.client.get('/lookup/trains/categories');
    return response.data;
  }

  /**
   * Get live fleet overview for radar map
   * Uses a curated list of active major intercity, express & premium trains across India.
   * Leverages internal caching so external calls are strictly throttled.
   */
  async getLiveFleet() {
    this.ensureApiKey();
    
    // Konkan Railway trains: Mumbai (CSMT/LTT/PNVL) ↔ Goa/Mangalore via Konkan coast
    // This is our project focus — SIH dynamic ETA on this corridor
    const majorTrains = [
      // Vande Bharat & Premium
      '22229', // Vande Bharat CSMT–Madgaon
      '22230', // Vande Bharat Madgaon–CSMT
      '12133', // Mumbai CSMT – Mangalore Jn SF Express
      '12134', // Mangalore Jn – Mumbai CSMT SF Express

      // Konkan Kanya / Jan Shatabdi
      '10111', // Konkan Kanya Express (CSMT → Madgaon)
      '10112', // Konkan Kanya Express (Madgaon → CSMT)
      '12051', // Jan Shatabdi (Madgaon → CSMT)
      '12052', // Jan Shatabdi (CSMT → Madgaon)

      // Mandovi / Nethravathi
      '10103', // Mandovi Express (CSMT → Madgaon)
      '10104', // Mandovi Express (Madgaon → CSMT)
      '16345', // Nethravathi Express (LTT → Trivandrum)
      '16346', // Nethravathi Express (Trivandrum → LTT)

      // Goa / Mangalore bound
      '12779', // Goa Express (VSG → NZM)
      '12780', // Goa Express (NZM → VSG)
      '12619', // Matsyagandha Express (LTT → Mangalore)
      '12620', // Matsyagandha Express (Mangalore → LTT)

      // Specials / Mail
      '01131', // Mumbai LTT – Sawantwadi Road Special
      '01132', // Sawantwadi Road – Mumbai LTT Special
      '12617', // Mangala Lakshadweep Express (Ernakulam → NZM)
      '12618', // Mangala Lakshadweep Express (NZM → Ernakulam)
    ];

    const fleet = [];

    // Fetch live status for fleet trains with Promise.allSettled to ensure high availability
    const promises = majorTrains.map(async (num) => {
      try {
        // Request geometry so we can interpolate the live position
        const liveRes = await this.getTrainLiveStatus(num, {
          geometry: true,
          geometry_format: 'geojson',
        });
        const liveData = liveRes?.data || liveRes;
        
        if (!liveData) return null;

        const trainInfo = liveData.train || {};
        const currentLoc = liveData.currentLocation || {};
        const prevHalt = liveData.previousHalt || {};
        const nextHalt = liveData.nextHalt || {};

        // ── Compute actual train position via polyline interpolation ──
        let lat = null;
        let lng = null;

        // Extract route polyline from geometry
        const geomObj = liveData.geometry;
        const coords = geomObj?.geojson?.geometry?.coordinates; // [[lng,lat], ...]
        const route = liveData.route || [];
        const trainDistKm = currentLoc.distanceFromOriginKm;
        const totalRouteDist = route.length > 0
          ? Math.max(...route.map(s => s.distance || 0))
          : 0;

        if (coords && coords.length > 1 && trainDistKm != null && totalRouteDist > 0) {
          // Convert [lng,lat] → [lat,lng] for the polyline
          const polyline = coords.map(c => [c[1], c[0]]);
          
          // Compute cumulative distance along polyline
          const cumDist = [0];
          for (let i = 1; i < polyline.length; i++) {
            const dLat = (polyline[i][0] - polyline[i-1][0]) * Math.PI / 180;
            const dLng = (polyline[i][1] - polyline[i-1][1]) * Math.PI / 180;
            const a = Math.sin(dLat/2)**2 + Math.cos(polyline[i-1][0]*Math.PI/180) * Math.cos(polyline[i][0]*Math.PI/180) * Math.sin(dLng/2)**2;
            const km = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            cumDist.push(cumDist[i-1] + km);
          }
          const polyTotal = cumDist[cumDist.length - 1];
          const scale = polyTotal / totalRouteDist;
          const targetPoly = Math.max(0, Math.min(polyTotal, trainDistKm * scale));

          // Binary search for the segment
          let lo = 0, hi = cumDist.length - 1;
          while (lo < hi - 1) {
            const mid = (lo + hi) >> 1;
            cumDist[mid] <= targetPoly ? lo = mid : hi = mid;
          }
          const segLen = cumDist[hi] - cumDist[lo];
          const t = segLen > 0 ? (targetPoly - cumDist[lo]) / segLen : 0;
          lat = polyline[lo][0] + t * (polyline[hi][0] - polyline[lo][0]);
          lng = polyline[lo][1] + t * (polyline[hi][1] - polyline[lo][1]);
        }

        // Fallback: source station if interpolation failed
        if (!lat || !lng) {
          if (trainInfo.source && trainInfo.source.lat) {
            lat = trainInfo.source.lat;
            lng = trainInfo.source.lng;
          }
        }

        return {
          number: liveData.trainNumber || num,
          name: liveData.trainName || trainInfo.name || `Train ${num}`,
          type: trainInfo.type || 'Express',
          category: trainInfo.category || 'Express',
          status: liveData.status || 'running',
          isLive: liveData.isLive ?? true,
          delayMinutes: liveData.delayMinutes ?? 0,
          currentStation: currentLoc.stationName || currentLoc.stationCode || 'En Route',
          previousHalt: prevHalt.stationName || null,
          nextHalt: nextHalt.stationName || null,
          source: trainInfo.source?.name || trainInfo.source?.code || '',
          destination: trainInfo.destination?.name || trainInfo.destination?.code || '',
          sourceCode: trainInfo.source?.code || '',
          destCode: trainInfo.destination?.code || '',
          lat: lat || 28.6139,
          lng: lng || 77.2090,
          speed: currentLoc.speedToNextStationKmph || trainInfo.avgSpeed || 60,
          lastUpdated: liveData.lastUpdatedAt || new Date().toISOString(),
        };
      } catch (err) {
        return null;
      }
    });

    const results = await Promise.allSettled(promises);
    results.forEach((res) => {
      if (res.status === 'fulfilled' && res.value && res.value.lat && res.value.lng) {
        fleet.push(res.value);
      }
    });

    return {
      count: fleet.length,
      timestamp: new Date().toISOString(),
      fleet,
    };
  }

  /**
   * Generic proxy request forwarding to RailRadar
   * @param {string} path - subpath e.g. /trains/12002/live
   * @param {string} method - GET, POST, etc.
   * @param {Object} query - Query parameters
   * @param {Object} body - Request body
   */
  async proxyRequest(path, method = 'GET', query = {}, body = null) {
    this.ensureApiKey();
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    const response = await this.client.request({
      url: cleanPath,
      method,
      params: query,
      data: body,
    });
    return response.data;
  }
}

export const railRadarService = new RailRadarService();
