FROM node:20-slim

# Obscura replaces Chromium (stealth headless browser, CDP on 9222)
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        tar \
        fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && arch="$(uname -m)" \
    && case "$arch" in \
         x86_64) OBSCURA_ARCH=x86_64 ;; \
         aarch64|arm64) OBSCURA_ARCH=aarch64 ;; \
         *) OBSCURA_ARCH=x86_64 ;; \
       esac \
    && curl -fsSL -o /tmp/obscura.tgz \
         "https://github.com/h4ckf0r0day/obscura/releases/latest/download/obscura-${OBSCURA_ARCH}-linux.tar.gz" \
    && tar xzf /tmp/obscura.tgz -C /usr/local/bin \
    && chmod +x /usr/local/bin/obscura /usr/local/bin/obscura-worker \
    && rm -f /tmp/obscura.tgz

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
