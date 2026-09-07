#!/bin/bash
# Start the proxy immediately; capture and refresh channels in the background.
set -e

export CHANNEL_ID=${CHANNEL_ID:-10}
export CHANNEL_IDS=${CHANNEL_IDS:-1,2,4,5,9,10,11,12}
export PORT=${PORT:-53535}
export CACHE_FILE=${CACHE_FILE:-/app/data/m3u8-cache.json}
export CAPTURE_INTERVAL=${CAPTURE_INTERVAL:-36000000}

cd /app
echo "kankanews HLS Proxy: port ${PORT}; channels ${CHANNEL_IDS}"
node src/vps-server.js &
SERVER_PID=$!
node src/capture-loop.js &
CAPTURE_PID=$!

cleanup() {
  kill "$CAPTURE_PID" "$SERVER_PID" 2>/dev/null || true
  wait "$CAPTURE_PID" "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' SIGTERM SIGINT

echo "Playlist: http://localhost:${PORT}/wx.m3u"
wait -n "$CAPTURE_PID" "$SERVER_PID"
