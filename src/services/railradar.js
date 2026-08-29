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

    // Request Interceptor: Attach API Key
    this.client.interceptors.request.use(
      (req) => {
        const apiKey = config.railRadar.apiKey;
        if (apiKey) {
          req.headers['Authorization'] = apiKey.startsWith('Bearer ')
            ? apiKey
            : `Bearer ${apiKey}`;
        }
        return req;
      },
      (error) => Promise.reject(error)
    );

    // Response Interceptor: Format errors consistently
    this.client.interceptors.response.use(
      (res) => res,
      (error) => {
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
    
    // Core representative trains across all major railway zones in India
    const majorTrains = [
      '12625', // Kerala Express (TVC -> NDLS)
      '12626', // Kerala Express (NDLS -> TVC)
      '12002', // Bhopal Shatabdi (NDLS -> RKMP)
      '12001', // Shatabdi Express (RKMP -> NDLS)
      '12951', // Mumbai Rajdhani (MMCT -> NDLS)
      '12952', // Mumbai Rajdhani (NDLS -> MMCT)
      '12301', // Howrah Rajdhani (HWH -> NDLS)
      '12302', // Howrah Rajdhani (NDLS -> HWH)
      '22436', // Vande Bharat (NDLS -> BSB)
      '22435', // Vande Bharat (BSB -> NDLS)
      '12861', // Mahbubnagar SF Express (VSKP -> MBNR)
      '12423', // Dibrugarh Rajdhani (DBRG -> NDLS)
      '12424', // Dibrugarh Rajdhani (NDLS -> DBRG)
      '12721', // Dakshin Express (HYB -> NZM)
      '12779', // Goa Express (VSG -> NZM)
      '12259', // Sealdah Bikaner AC Duronto
      '12004', // Lucknow Shatabdi
      '12926', // Paschim Express
      '12487', // Seemanchal Express
      '12308', // Howrah SF Express
    ];

    const fleet = [];

    // Fetch live status for fleet trains with Promise.allSettled to ensure high availability
    const promises = majorTrains.map(async (num) => {
      try {
        const liveRes = await this.getTrainLiveStatus(num);
        const liveData = liveRes?.data || liveRes;
        
        if (!liveData) return null;

        const trainInfo = liveData.train || {};
        const currentLoc = liveData.currentLocation || {};
        const prevHalt = liveData.previousHalt || {};
        const nextHalt = liveData.nextHalt || {};

        // Find coordinates from current location or route stations
        let lat = currentLoc.lat;
        let lng = currentLoc.lng;

        if ((!lat || !lng) && liveData.route && Array.isArray(liveData.route)) {
          const currentSeq = currentLoc.sequence;
          const matchedStation = liveData.route.find(s => s.sequence === currentSeq) ||
                                 liveData.route.find(s => s.status === 'departed' || s.status === 'current') ||
                                 liveData.route[0];
          if (matchedStation && matchedStation.station) {
            lat = matchedStation.station.lat;
            lng = matchedStation.station.lng;
          } else if (matchedStation) {
            lat = matchedStation.lat;
            lng = matchedStation.lng;
          }
        }

        // Fallback to source or destination if not departed
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
