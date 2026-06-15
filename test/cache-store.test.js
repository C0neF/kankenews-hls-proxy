const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { getCacheFile, getDefaultCacheFile, readCache } = require('../src/cache-store');

test('explicit channel cache does not fall back to the default cache file', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-cache-'));
  await fs.writeFile(
    path.join(dataDir, 'm3u8-cache.json'),
    JSON.stringify({ channelId: '10', url: 'https://example.test/default.m3u8' })
  );

  const cache = await readCache('1', { dataDir, defaultChannelId: '10' });

  assert.equal(cache, null);
});

test('default channel can read the legacy default cache file', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-cache-'));
  await fs.writeFile(
    path.join(dataDir, 'm3u8-cache.json'),
    JSON.stringify({ channelId: '10', url: 'https://example.test/default.m3u8' })
  );

  const cache = await readCache('10', { dataDir, defaultChannelId: '10' });

  assert.equal(cache.url, 'https://example.test/default.m3u8');
});

test('per-channel cache path is stable', () => {
  const dataDir = path.join(os.tmpdir(), 'kk-cache-path');

  assert.equal(getCacheFile('12', dataDir), path.join(dataDir, 'm3u8-cache-12.json'));
  assert.equal(getDefaultCacheFile(dataDir), path.join(dataDir, 'm3u8-cache.json'));
});
