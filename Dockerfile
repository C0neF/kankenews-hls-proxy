FROM node:20-slim

# Install Playwright dependencies
RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci && npx playwright install chromium && npx playwright install-deps chromium

# Copy source
COPY src/ ./src/

# Create cache directory
RUN mkdir -p /app/seg-cache /app/data

# Environment
ENV PORT=53535
ENV CACHE_FILE=/app/data/m3u8-cache.json
ENV SEG_CACHE_DIR=/app/seg-cache
ENV CHANNEL_ID=10
ENV CAPTURE_INTERVAL=36000000

EXPOSE 53535

# Start script
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

ENTRYPOINT ["./docker-entrypoint.sh"]
