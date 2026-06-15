const fsp = require('node:fs/promises');
const path = require('node:path');

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

module.exports = {
  getCacheFile,
  getDataDir,
  getDefaultCacheFile,
  getDefaultChannelId,
  readCache,
};
