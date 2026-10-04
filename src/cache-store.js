const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function getDataDir(cacheFile = process.env.CACHE_FILE) {
  return cacheFile ? path.dirname(cacheFile) : '/app/data';
}

function getDefaultChannelId(env = process.env) {
  return env.CHANNEL_ID || '10';
}

function getCacheFile(channelId, dataDir = getDataDir()) {
  return path.join(dataDir, `m3u8-cache-${channelId}.json`);
}

function getDefaultCacheFile(dataDir = getDataDir()) {
  return path.join(dataDir, 'm3u8-cache.json');
}

async function readJson(file) {
  const data = await fsp.readFile(file, 'utf8');
  return JSON.parse(data);
}

async function readCache(channelId = getDefaultChannelId(), options = {}) {
  const dataDir = options.dataDir || getDataDir(options.cacheFile);
  const defaultChannelId = options.defaultChannelId || getDefaultChannelId();

  try {
    return await readJson(getCacheFile(channelId, dataDir));
  } catch {}

  if (String(channelId) !== String(defaultChannelId)) return null;

  try {
    return await readJson(getDefaultCacheFile(dataDir));
  } catch {}

  return null;
}

// Playback requests flag a refused URL (e.g. CDN 403) so the capture loop can retry
// soon. Only write when the cache still holds the failed URL, so a stale report from
// the proxy can never clobber a freshly captured cache.
async function markCacheFailed(channelId, failedUrl, options = {}) {
  const dataDir = options.dataDir || getDataDir();
  const file = getCacheFile(channelId, dataDir);
  try {
    const cache = await readJson(file);
    if (!cache || cache.url !== failedUrl) return false;
    cache.failedAt = Math.floor(Date.now() / 1000);
    const temporaryFile = `${file}.${randomUUID()}.tmp`;
    await fsp.writeFile(temporaryFile, JSON.stringify(cache, null, 2));
    await fsp.rename(temporaryFile, file);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  getCacheFile,
  getDataDir,
  getDefaultCacheFile,
  getDefaultChannelId,
  markCacheFailed,
  readCache,
};
