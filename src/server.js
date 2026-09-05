import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';

import { config, validateConfig } from './config/env.js';
import { apiLimiter } from './middleware/rateLimiter.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import apiRoutes from './routes/api.routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Validate configuration on boot
validateConfig();

const app = express();

// Security & Parsing Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// HTTP Request Logger
if (config.nodeEnv !== 'test') {
  app.use(morgan('dev'));
}

// Static Developer Dashboard UI
app.use(express.static(path.join(__dirname, '../public')));

// Rate Limiter applied to API routes
app.use('/api', apiLimiter);

// API Routes
app.use('/api', apiRoutes);

// 404 & Global Error Handling
app.use(notFoundHandler);
app.use(errorHandler);

// Start server with automatic port retry if busy
const startServer = (portToTry) => {
  const server = app.listen(portToTry, () => {
    console.log(`
  🚄 \x1b[36m\x1b[1mGATI — dynamic ETA gateway is running!\x1b[0m
  --------------------------------------------------
  ➜ \x1b[32mLocal:\x1b[0m            http://localhost:${portToTry}
  ➜ \x1b[32mAPI Base:\x1b[0m         http://localhost:${portToTry}/api
  ➜ \x1b[32mHealth Check:\x1b[0m     http://localhost:${portToTry}/api/health
  ➜ \x1b[32mEnvironment:\x1b[0m      ${config.nodeEnv}
  ➜ \x1b[32mRailRadar Base:\x1b[0m   ${config.railRadar.baseUrl}
  ➜ \x1b[32mAPI Key Loaded:\x1b[0m   ${config.railRadar.apiKey ? '✅ Yes' : '❌ No (set in .env)'}
  --------------------------------------------------
    `);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`\x1b[33m⚠️ Port ${portToTry} is in use. Trying port ${portToTry + 1}...\x1b[0m`);
      startServer(portToTry + 1);
    } else {
      console.error('Server error:', err);
    }
  });

  return server;
};

const server = startServer(config.port);

export default app;
