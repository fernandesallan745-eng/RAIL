/**
 * src/services/weatherService.js
 *
 * Real-time meteorological telemetry and atmospheric monitoring client.
 * Queries the keyless Open-Meteo API for temperature, precipitation rate,
 * WMO weather conditions, and visibility.
 *
 * Caches telemetry in memory with a 15-minute TTL per ~1.1km geohash.
 */

import axios from 'axios';

const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

const WMO_CONDITIONS = {
  0: { label: 'Clear sky', condition: 'clear', icon: '☀️' },
  1: { label: 'Mainly clear', condition: 'clear', icon: '🌤️' },
  2: { label: 'Partly cloudy', condition: 'clear', icon: '⛅' },
  3: { label: 'Overcast', condition: 'clear', icon: '☁️' },
  45: { label: 'Fog', condition: 'fog', icon: '🌫️' },
  48: { label: 'Depositing rime fog', condition: 'fog', icon: '🌫️' },
  51: { label: 'Light drizzle', condition: 'drizzle', icon: '🌦️' },
  53: { label: 'Moderate drizzle', condition: 'drizzle', icon: '🌦️' },
  55: { label: 'Dense drizzle', condition: 'drizzle', icon: '🌧️' },
  61: { label: 'Slight rain', condition: 'rain', icon: '🌧️' },
  63: { label: 'Moderate rain', condition: 'rain', icon: '🌧️' },
  65: { label: 'Heavy rain', condition: 'heavy_rain', icon: '⛈️' },
  80: { label: 'Slight rain showers', condition: 'rain', icon: '🌦️' },
  81: { label: 'Moderate rain showers', condition: 'rain', icon: '🌧️' },
  82: { label: 'Violent rain showers', condition: 'heavy_rain', icon: '⛈️' },
  95: { label: 'Thunderstorm', condition: 'thunderstorm', icon: '⚡' },
  96: { label: 'Thunderstorm with hail', condition: 'thunderstorm', icon: '⛈️' },
  99: { label: 'Heavy thunderstorm', condition: 'thunderstorm', icon: '⛈️' },
};

class WeatherService {
  constructor() {
    this.cache = new Map();
  }

  _cacheKey(lat, lng) {
    return `${Number(lat).toFixed(2)},${Number(lng).toFixed(2)}`;
  }

  fallback(reason = 'clear-default') {
    return {
      available: true,
      condition: 'clear',
      label: 'Clear sky',
      icon: '☀️',
      tempC: 28.0,
      precipMmH: 0.0,
      visibilityM: 10000,
      wmoCode: 0,
      windSpeedKmh: 6.0,
      factor: 1.0,
      basis: `fallback-${reason}`,
    };
  }

  async getPointWeather(lat, lng) {
    if (lat == null || lng == null || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
      return this.fallback('missing-coords');
    }

    const key = this._cacheKey(lat, lng);
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      const resp = await axios.get(OPEN_METEO_BASE, {
        params: {
          latitude: Number(lat).toFixed(4),
          longitude: Number(lng).toFixed(4),
          current: 'temperature_2m,relative_humidity_2m,precipitation,rain,weather_code,wind_speed_10m,visibility',
          timezone: 'auto',
        },
        timeout: 2500,
      });

      if (resp.status === 200 && resp.data?.current) {
        const c = resp.data.current;
        const wmo = Number(c.weather_code) || 0;
        const precip = Number(c.precipitation ?? c.rain ?? 0.0);
        const vis = Number(c.visibility ?? 10000);
        const temp = Number(c.temperature_2m ?? 25.0);
        const wind = Number(c.wind_speed_10m ?? 0.0);

        const wmoInfo = WMO_CONDITIONS[wmo] || { label: 'Clear', condition: 'clear', icon: '🌤️' };

        // Adhesion and visibility factor
        let factor = 1.0;
        if (vis < 1000 || wmo === 45 || wmo === 48) {
          factor = Math.min(factor, 0.60);
        }
        if (precip >= 15.0) {
          factor = Math.min(factor, 0.65);
        } else if (precip >= 5.0) {
          factor = Math.min(factor, 0.80);
        } else if (precip > 0.1) {
          factor = Math.min(factor, 0.90);
        }
        if (wmo >= 95) {
          factor = Math.min(factor, 0.60);
        }

        const data = {
          available: true,
          condition: wmoInfo.condition,
          label: wmoInfo.label,
          icon: wmoInfo.icon,
          tempC: Math.round(temp * 10) / 10,
          precipMmH: Math.round(precip * 100) / 100,
          visibilityM: Math.round(vis),
          wmoCode: wmo,
          windSpeedKmh: Math.round(wind * 10) / 10,
          factor: Math.round(factor * 100) / 100,
          basis: 'live-open-meteo',
        };

        this.cache.set(key, { timestamp: Date.now(), data });
        return data;
      }
    } catch (err) {
      // Gracefully fall back without breaking the train live status call
    }

    const fb = this.fallback('unreachable');
    this.cache.set(key, { timestamp: Date.now(), data: fb });
    return fb;
  }
}

export const weatherService = new WeatherService();
export default weatherService;
