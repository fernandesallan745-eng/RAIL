# 🚄 RailRadar API Backend Proxy

A robust, modular Node.js & Express backend proxy server for the [RailRadar API](https://railradar.in/docs) (Indian Railways data).

## 🌟 Key Features

- **Secure API Key Management**: Loads your `RAILRADAR_API_KEY` from `.env` and automatically handles `Bearer` token authorization headers for every upstream request.
- **Smart Response Caching**: In-memory TTL caching with `node-cache` (60s for live running status, 1hr for static schedules/routes) to avoid burning API rate limits and conserve API credits.
- **Rate Limiting & Protection**: Built-in `express-rate-limit` to prevent request flooding.
- **Error Resilience**: Intercepts upstream RailRadar errors (401, 404, 429, 504 timeouts) and formats them into clean, structured JSON responses.
- **Interactive Developer Explorer**: A built-in dark-mode web dashboard at `http://localhost:5000` to test train numbers, view real-time delays, inspect route geometries, and copy responses.
- **Generic Proxy Support**: Transparently proxies any custom RailRadar subpath via `/api/proxy/*`.

---

## 🚀 Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Your API Key
Open `.env` and add your RailRadar API key:
```env
PORT=5000
RAILRADAR_API_KEY=your_railradar_api_key_here
RAILRADAR_BASE_URL=https://api.railradar.in/v1
```

### 3. Start the Server
```bash
# Production mode
npm start

# Development mode (with auto-reload)
npm run dev
```

Visit **`http://localhost:5000`** in your browser to open the interactive API tester.

---

## 📡 Available API Endpoints

| Method | Endpoint | Description | Cache TTL |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/health` | Server health & API key configuration state | No cache |
| `GET` | `/api/trains/:trainNumber/live` | Real-time train running status, delays, current position | 60 seconds |
| `GET` | `/api/trains/:trainNumber` | Train timetable, halts, and full schedule | 1 hour |
| `GET` | `/api/trains/:trainNumber/route` | GeoJSON route geometry coordinates for maps | 1 hour |
| `GET` | `/api/trains/:trainNumber/coaches` | Coach composition and seating layout | 1 hour |
| `GET` | `/api/trains/search?q=:query` | Autocomplete search for trains by name or number | 1 hour |
| `GET` | `/api/lookup/categories` | Train category metadata list | 24 hours |
| `ALL` | `/api/proxy/*` | Transparent proxy forwarding to any RailRadar endpoint | Variable |

---

## 💻 Example Requests

### 1. Live Running Status
```bash
curl http://localhost:5000/api/trains/12002/live
```

### 2. Train Timetable & Halts
```bash
curl http://localhost:5000/api/trains/12002
```

### 3. Train Search
```bash
curl "http://localhost:5000/api/trains/search?q=Shatabdi"
```

### 4. Health Check
```bash
curl http://localhost:5000/api/health
```

---

## 📁 Project Structure

```
.
├── .env                  # Environment variables & API key (gitignored)
├── .env.example          # Sample environment template
├── package.json          # Project configuration & dependencies
├── public/
│   └── index.html        # Interactive API tester & Developer UI
├── src/
│   ├── config/
│   │   └── env.js        # Environment config loader & validation
│   ├── controllers/
│   │   └── train.controller.js # Request handlers for train endpoints
│   ├── middleware/
│   │   ├── cache.js      # In-memory TTL caching middleware
│   │   ├── errorHandler.js # Centralized JSON error handling
│   │   └── rateLimiter.js# Rate limiting middleware
│   ├── routes/
│   │   └── api.routes.js # REST API route declarations
│   ├── services/
│   │   └── railradar.js  # RailRadar API HTTP client wrapper
│   └── server.js         # Express main entry point
└── README.md
```
