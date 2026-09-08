# Production Dockerfile for GATI (Node.js Gateway + Python FastAPI Model)
FROM node:20-slim

# Install Python 3 and pip
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip python3-venv curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# Install Node dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Ensure production environment
ENV NODE_ENV=production
ENV PORT=5050
ENV GATI_MODEL_HOST=127.0.0.1
ENV MODEL_API_URL=http://127.0.0.1:8000

# Expose Render's public web port
EXPOSE 5050

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${PORT}/api/health || exit 1

# Start both Python GATI Model and Node Express Gateway
CMD ["npm", "start"]
