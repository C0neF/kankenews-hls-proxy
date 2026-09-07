const { setTimeout: sleep } = require('node:timers/promises');
const { capture } = require('./vps-capture');
const { getCacheFile, getDataDir, getDefaultChannelId, readCache } = require('./cache-store');

const DEFAULT_INTERVAL = 36000000;
const RETRY_DELAY = 60000;

function needsCapture(cache, now = Date.now(), interval = DEFAULT_INTERVAL) {
  if (!cache?.url || !Number.isFinite(cache.capturedAt)) return true;
  if (now >= cache.capturedAt * 1000 + interval) return true;
  return Number.isFinite(cache.exp) && now >= cache.exp * 1000 - 300000;
}

async function captureDueChannels({
  channelIds, dataDir = getDataDir(), interval = DEFAULT_INTERVAL,
  nextAttempts = new Map(), captureFn = capture, now = Date.now,
}) {
  for (const channelId of channelIds) {
    if (now() < (nextAttempts.get(channelId) || 0)) continue;
    const cache = await readCache(channelId, { dataDir, defaultChannelId: getDefaultChannelId() });
    if (!needsCapture(cache, now(), interval)) continue;
    try {
      await captureFn({ channelId, cacheFile: getCacheFile(channelId, dataDir) });
    } catch (error) {
      console.error(`[Capture] Channel ${channelId}: ${error.message}`);
    } finally {
      nextAttempts.set(channelId, now() + RETRY_DELAY);
    }
  }
}

async function run() {
  const channelIds = [...new Set((process.env.CHANNEL_IDS || '1,2,4,5,9,10,11,12')
    .split(',').map(id => id.trim()).filter(id => /^\d+$/.test(id)))];
  if (!channelIds.length) throw new Error('CHANNEL_IDS must contain numeric channel IDs');
  const interval = Number(process.env.CAPTURE_INTERVAL || DEFAULT_INTERVAL);
  if (!Number.isFinite(interval) || interval <= 0) throw new Error('CAPTURE_INTERVAL must be positive');
  const nextAttempts = new Map();
  console.log(`[Capture] Channels: ${channelIds.join(',')}; refresh 5 minutes before expiry; retry after 60s.`);
  while (true) {
    await captureDueChannels({ channelIds, interval, nextAttempts });
    await sleep(30000);
  }
}

if (require.main === module) {
  run().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { needsCapture, captureDueChannels };
