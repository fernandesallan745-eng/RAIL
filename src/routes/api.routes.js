import { Router } from 'express';
import {
  getHealth,
  getTrainSchedule,
  getTrainLiveStatus,
  getTrainRoute,
  getTrainCoaches,
  searchTrains,
  getTrainCategories,
  getLiveFleet,
  proxyPass,
} from '../controllers/train.controller.js';
import { cacheMiddleware } from '../middleware/cache.js';
import { config } from '../config/env.js';

const router = Router();

// Health check & credentials status
router.get('/health', getHealth);

// Live Radar Fleet across India (cached for 5 min to conserve API quota)
router.get('/trains/radar/fleet', cacheMiddleware(config.cache.liveTtl), getLiveFleet);

// Train search / autocomplete
router.get('/trains/search', cacheMiddleware(config.cache.staticTtl), searchTrains);

// Train specific details
router.get('/trains/:trainNumber/live', cacheMiddleware(config.cache.liveTtl), getTrainLiveStatus);
router.get('/trains/:trainNumber/route', cacheMiddleware(config.cache.staticTtl), getTrainRoute);
router.get('/trains/:trainNumber/coaches', cacheMiddleware(config.cache.staticTtl), getTrainCoaches);
router.get('/trains/:trainNumber', cacheMiddleware(config.cache.staticTtl), getTrainSchedule);

// Lookups
router.get('/lookup/categories', cacheMiddleware(86400), getTrainCategories);

// Transparent proxy for any RailRadar endpoint
router.all('/proxy/*', proxyPass);

export default router;
