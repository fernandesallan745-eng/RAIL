import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

// Recalculating keys on watch reload

// Extract all instances of RAILRADAR_API_KEY from .env manually
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const apiKeys = [];
try {
  const envPath = path.join(__dirname, '../../.env');
  const envContent = fs.readFileSync(envPath, 'utf-8');
  const lines = envContent.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (key === 'RAILRADAR_API_KEY' && val) {
        // Strip quotes if present
        const cleanVal = val.replace(/^["']|["']$/g, '').trim();
        if (cleanVal && !apiKeys.includes(cleanVal)) {
          apiKeys.push(cleanVal);
        }
      }
    }
  }
} catch (e) {
  // fallback to standard single key
}

// Ensure we have at least standard dotenv parsed key if manual parsing failed
if (apiKeys.length === 0 && process.env.RAILRADAR_API_KEY) {
  apiKeys.push(process.env.RAILRADAR_API_KEY.trim());
}

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  railRadar: {
    apiKey: apiKeys[0] || '',
    apiKeys: apiKeys,
    baseUrl: (process.env.RAILRADAR_BASE_URL || 'https://api.railradar.in/v1').replace(/\/+$/, ''),
    timeout: parseInt(process.env.REQUEST_TIMEOUT_MS || '15000', 10),
  },
  cache: {
    liveTtl: parseInt(process.env.CACHE_TTL_LIVE || '300', 10),
    staticTtl: parseInt(process.env.CACHE_TTL_STATIC || '86400', 10),
  },
};

export const validateConfig = () => {
  if (config.railRadar.apiKeys.length === 0) {
    console.warn('\x1b[33m⚠️  [RailRadar Config Warning] No RAILRADAR_API_KEY is set in .env. API calls will return 401 until configured.\x1b[0m');
  } else {
    console.log(`\x1b[32m✔ [RailRadar Config] Loaded ${config.railRadar.apiKeys.length} API keys successfully. Active: ${config.railRadar.apiKey.slice(0, 8)}...\x1b[0m`);
  }
};
