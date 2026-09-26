FROM node:20-slim

# Obscura replaces Chromium. Copy binaries from the official image
# (avoids a 70MB GitHub download during build).
COPY --from=h4ckf0r0day/obscura:latest /obscura /usr/local/bin/obscura
COPY --from=h4ckf0r0day/obscura:latest /obscura-worker /usr/local/bin/obscura-worker

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && chmod +x /usr/local/bin/obscura /usr/local/bin/obscura-worker

WORKDIR /app

COPY package.json package-lock.json ./
# playwright-core is a CDP client only — no Chromium download
RUN npm ci --omit=dev || npm install --omit=dev

COPY src/ ./src/
RUN mkdir -p /app/seg-cache /app/data

ENV PORT=53535
ENV CACHE_FILE=/app/data/m3u8-cache.json
ENV SEG_CACHE_DIR=/app/seg-cache
ENV CHANNEL_ID=10
ENV CAPTURE_INTERVAL=36000000
ENV BROWSER_CDP_URL=ws://127.0.0.1:9222
ENV OBSCURA_PORT=9222

EXPOSE 53535

COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

ENTRYPOINT ["./docker-entrypoint.sh"]
