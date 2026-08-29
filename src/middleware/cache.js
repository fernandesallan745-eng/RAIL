import NodeCache from 'node-cache';
import { config } from '../config/env.js';

// Global cache instance
export const cache = new NodeCache({
  stdTTL: config.cache.liveTtl,
  checkperiod: 120,
  useClones: false,
});

/**
 * Express caching middleware generator
 * @param {number} ttlSeconds - Time-to-live in seconds
 */
export const cacheMiddleware = (ttlSeconds = config.cache.liveTtl) => {
  return (req, res, next) => {
    // Only cache GET requests
    if (req.method !== 'GET') {
      return next();
    }

    // Generate unique cache key based on URL and query params
    const key = `__cache__${req.originalUrl || req.url}`;
    const cachedResponse = cache.get(key);

    if (cachedResponse) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(cachedResponse);
    }

    // Intercept res.json to store in cache on success
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      // Only cache successful 200 responses
      if (res.statusCode >= 200 && res.statusCode < 300 && body) {
        cache.set(key, body, ttlSeconds);
        res.setHeader('X-Cache', 'MISS');
      }
      return originalJson(body);
    };

    next();
  };
};

/**
 * Flush cache manually or for testing
 */
export const clearCache = () => {
  cache.flushAll();
};
