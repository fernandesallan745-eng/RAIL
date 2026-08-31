import NodeCache from 'node-cache';
import { config } from '../config/env.js';

// Global cache instance.
//
// stdTTL is deliberately the STATIC ttl, not config.cache.liveTtl. node-cache reads stdTTL:0 as
// "entries never expire", so wiring the (now 0 by default) live TTL in here would turn live mode
// into permanent caching — the exact inverse of the intent. Live entries are never written at all
// (see the ttl <= 0 bypass below), so the only entries this instance holds are static ones.
export const cache = new NodeCache({
  stdTTL: config.cache.staticTtl,
  checkperiod: 120,
  useClones: false,
});

/**
 * Express caching middleware generator.
 *
 * ttlSeconds <= 0 means BYPASS: no read, no write, nothing stored. Live endpoints pass
 * config.cache.liveTtl, which now defaults to 0, so every poll of a train position is a real
 * upstream call. Serving a cached position while labelling it live is the same class of honesty
 * bug as rendering an untracked run as "On Time" — so the bypass has to cut both directions,
 * not just skip the read.
 *
 * @param {number} ttlSeconds - Time-to-live in seconds; <= 0 disables caching for the route.
 */
export const cacheMiddleware = (ttlSeconds = config.cache.liveTtl) => {
  return (req, res, next) => {
    // Only cache GET requests
    if (req.method !== 'GET') {
      return next();
    }

    // Caching disabled for this route: neither read nor write. Returning before res.json is
    // wrapped is what guarantees no write can happen, rather than relying on a later guard.
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      res.setHeader('X-Cache', 'BYPASS');
      return next();
    }

    // Generate unique cache key based on URL and query params
    const key = `__cache__${req.originalUrl || req.url}`;

    // Check if client is forcing a refresh
    const forceRefresh = req.query.refresh === 'true' || req.headers['x-refresh'] === 'true';
    const cachedResponse = forceRefresh ? null : cache.get(key);

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
