#!/bin/bash
# docker-entrypoint.sh - Docker 容器启动脚本
#
# 功能:
#   1. 重试捕获 m3u8 (网络未就绪时自动重试)
#   2. 启动定时捕获
#   3. 启动代理服务器

set -e

CAPTURE_INTERVAL=${CAPTURE_INTERVAL:-36000000}
CHANNEL_ID=${CHANNEL_ID:-10}
CHANNEL_IDS=${CHANNEL_IDS:-$CHANNEL_ID}
CACHE_FILE=${CACHE_FILE:-/app/data/m3u8-cache.json}
CACHE_DIR=$(dirname "$CACHE_FILE")
MAX_RETRIES=5
RETRY_DELAY=10

echo "========================================="
echo " kankanews HLS Proxy (Docker)"
echo "========================================="
echo ""
echo "  Channel ID:     ${CHANNEL_ID}"
echo "  Channel IDs:    ${CHANNEL_IDS}"
echo "  Port:           ${PORT:-3000}"
echo "  Capture Every:  ${CAPTURE_INTERVAL}ms (~$((CAPTURE_INTERVAL / 3600000))h)"
echo ""

capture_all_channels() {
  local failed=0
  local old_ifs="$IFS"
  IFS=','
  for channel in $CHANNEL_IDS; do
    [ -z "$channel" ] && continue
    echo "[Capture] Capturing channel ${channel}..."
    if ! CHANNEL_ID="$channel" CACHE_FILE="${CACHE_DIR}/m3u8-cache-${channel}.json" node src/vps-capture.js; then
      failed=1
    fi
  done
  IFS="$old_ifs"
  return $failed
}

# 首次捕获 (带重试)
cd /app
for i in $(seq 1 $MAX_RETRIES); do
  echo "[Init] Capture attempt $i/$MAX_RETRIES..."
  if capture_all_channels; then
    echo "[Init] Capture succeeded!"
    break
  fi
  if [ "$i" -eq "$MAX_RETRIES" ]; then
    echo "[Init] All $MAX_RETRIES attempts failed. Will retry via periodic capture."
  else
    echo "[Init] Failed, retrying in ${RETRY_DELAY}s..."
    sleep $RETRY_DELAY
  fi
done

# 启动定时捕获 (后台)
echo "[Capture] Starting periodic capture (every ${CAPTURE_INTERVAL}ms)..."
(
  while true; do
    sleep $((CAPTURE_INTERVAL / 1000))
    echo "[Capture] Running periodic capture..."
    capture_all_channels 2>&1 || echo "[Capture] Failed, will retry next cycle"
  done
) &
CAPTURE_PID=$!

# 启动代理服务器
echo "[Server] Starting proxy on port ${PORT:-3000}..."
node src/vps-server.js &
SERVER_PID=$!

# 优雅退出
cleanup() {
  echo ""
  echo "[Shutdown] Stopping services..."
  kill $CAPTURE_PID 2>/dev/null
  kill $SERVER_PID 2>/dev/null
  exit 0
}
trap cleanup SIGTERM SIGINT

echo ""
echo "========================================="
echo " Ready! PotPlayer: http://localhost:${PORT:-3000}/"
echo "========================================="
echo ""

wait -n $CAPTURE_PID $SERVER_PID
