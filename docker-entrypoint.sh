#!/bin/bash
set -e

export CHANNEL_ID=${CHANNEL_ID:-10}
export CHANNEL_IDS=${CHANNEL_IDS:-1,2,4,5,9,10,11,12}
export PORT=${PORT:-53535}
export CACHE_FILE=${CACHE_FILE:-/app/data/m3u8-cache.json}
export CAPTURE_INTERVAL=${CAPTURE_INTERVAL:-36000000}
export OBSCURA_PORT=${OBSCURA_PORT:-9222}
export BROWSER_CDP_URL=${BROWSER_CDP_URL:-ws://127.0.0.1:${OBSCURA_PORT}}
# Single-IP friendliness: slower, jittered API pacing and one shared capture page.
export API_MIN_INTERVAL_MS=${API_MIN_INTERVAL_MS:-3000}
export API_JITTER_MS=${API_JITTER_MS:-400}
export SESSION_IDLE_MS=${SESSION_IDLE_MS:-30000}

cd /app
echo "kankanews HLS Proxy: port ${PORT}; channels ${CHANNEL_IDS}"

# In-container Obscura (replaces Chromium)
if [ "${SKIP_OBSCURA:-0}" != "1" ]; then
  echo "Starting Obscura CDP on port ${OBSCURA_PORT}..."
  obscura serve --port "${OBSCURA_PORT}" --host 127.0.0.1 --stealth &
  OBSCURA_PID=$!
  for i in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:${OBSCURA_PORT}/json/version" >/dev/null 2>&1; then
      echo "Obscura CDP ready: ${BROWSER_CDP_URL}"
      break
    fi
    sleep 0.25
  done
fi

node src/vps-server.js &
SERVER_PID=$!
node src/capture-loop.js &
CAPTURE_PID=$!

cleanup() {
  kill "$CAPTURE_PID" "$SERVER_PID" 2>/dev/null || true
  if [ -n "${OBSCURA_PID:-}" ]; then kill "$OBSCURA_PID" 2>/dev/null || true; fi
  wait "$CAPTURE_PID" "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' SIGTERM SIGINT

echo "Playlist: http://localhost:${PORT}/wx.m3u"
wait -n "$CAPTURE_PID" "$SERVER_PID"
