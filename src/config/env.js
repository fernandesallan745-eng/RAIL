import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  railRadar: {
    apiKey: process.env.RAILRADAR_API_KEY ? process.env.RAILRADAR_API_KEY.trim() : '',
    baseUrl: (process.env.RAILRADAR_BASE_URL || 'https://api.railradar.in/v1').replace(/\/+$/, ''),
    timeout: parseInt(process.env.REQUEST_TIMEOUT_MS || '15000', 10),
  },
  cache: {
    liveTtl: parseInt(process.env.CACHE_TTL_LIVE || '300', 10), // 5 min for live data to conserve API quota
    staticTtl: parseInt(process.env.CACHE_TTL_STATIC || '86400', 10), // 24hr for static routes and timetables
  },
};

export const validateConfig = () => {
  if (!config.railRadar.apiKey) {
    console.warn('\x1b[33m⚠️  [RailRadar Config Warning] RAILRADAR_API_KEY is not set in .env. API calls will return 401 until configured.\x1b[0m');
  } else {
    console.log('\x1b[32m✔ [RailRadar Config] RAILRADAR_API_KEY detected and loaded successfully.\x1b[0m');
  }
};
