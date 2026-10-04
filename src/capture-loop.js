const { setTimeout: sleep } = require('node:timers/promises');
const { capture } = require('./vps-capture');
const { getCacheFile, getDataDir, getDefaultChannelId, readCache } = require('./cache-store');
const { streamExpiresAt, streamRenewalMargin } = require('./stream-lifetime');

const DEFAULT_INTERVAL = 36000000;
const RETRY_DELAY = 60000;
// Playback-side 403 marks (cache.failedAt) bypass the regular expiry schedule this long.
const FAILED_RETRY_WINDOW_MS = 10 * 60 * 1000;
// Escalating quiet periods after a WAF block: our own 60s retries kept feeding
// the block, so gate every channel and let the block expire instead.
const WAF_BACKOFF_STEPS_MS = [5 * 60000, 15 * 60000, 30 * 60000];

function needsCapture(cache, now = Date.now(), interval = DEFAULT_INTERVAL) {
  if (!cache?.url || !Number.isFinite(cache.capturedAt)) return true;
  if (Number.isFinite(cache.failedAt) && cache.failedAt > 0 &&
      now < cache.failedAt * 1000 + FAILED_RETRY_WINDOW_MS) return true;
  if (now >= cache.capturedAt * 1000 + interval) return true;
  const expiry = streamExpiresAt(cache);
  return expiry == null || now >= expiry - streamRenewalMargin(cache);
}

function wafBackoffDelay(strikes) {
  return WAF_BACKOFF_STEPS_MS[Math.min(Math.max(strikes, 1), WAF_BACKOFF_STEPS_MS.length) - 1];
}

async function captureDueChannels({
  channelIds, dataDir = getDataDir(), interval = DEFAULT_INTERVAL,
  nextAttempts = new Map(), captureFn = capture, now = Date.now,
  sourceStates = new Map(), wafState = { strikes: 0, until: 0 },
}) {
  for (const channelId of channelIds) {
    if (now() < Math.max(nextAttempts.get(channelId) || 0, wafState.until || 0)) continue;
    const cache = await readCache(channelId, { dataDir, defaultChannelId: getDefaultChannelId() });
    if (!needsCapture(cache, now(), interval)) continue;
    const attemptStart = now();
    let result = null;
    try {
      if (!sourceStates.has(channelId)) sourceStates.set(channelId, {});
      result = await captureFn({
        channelId, cacheFile: getCacheFile(channelId, dataDir),
        sourceState: sourceStates.get(channelId), previousCache: cache,
      });
    } catch (error) {
      console.error(`[Capture] Channel ${channelId}: ${error.message}`);
    }
    if (result) {
      // A source was captured, so the upstream is clearly not blocking us.
      wafState.strikes = 0;
      wafState.until = 0;
      nextAttempts.set(channelId, now() + RETRY_DELAY);
      continue;
    }
    const state = sourceStates.get(channelId) || {};
    if (Number.isFinite(state.wafHitAt) && state.wafHitAt > attemptStart) {
      wafState.strikes += 1;
      const delay = wafBackoffDelay(wafState.strikes);
      wafState.until = now() + delay;
      nextAttempts.set(channelId, now() + delay);
      console.log(`[Capture] Channel ${channelId}: WAF block, quiet for ${Math.round(delay / 60000)} min (strike ${wafState.strikes}).`);
    } else {
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
  const sourceStates = new Map();
  const wafState = { strikes: 0, until: 0 };
  console.log(`[Capture] Channels: ${channelIds.join(',')}; refresh up to 2 minutes before expiry; retry after 60s; WAF blocks quiet for 5/15/30 min.`);
  while (true) {
    await captureDueChannels({ channelIds, interval, nextAttempts, sourceStates, wafState });
    await sleep(10000);
  }
}

if (require.main === module) {
  run().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { needsCapture, captureDueChannels, wafBackoffDelay, WAF_BACKOFF_STEPS_MS };
