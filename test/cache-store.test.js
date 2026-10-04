const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { getCacheFile, getDefaultCacheFile, markCacheFailed, readCache } = require('../src/cache-store');

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

test('markCacheFailed flags only the cache that still holds the failed URL', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-cache-fail-'));
  t.after(() => fs.rmdir(dataDir, { recursive: true }));
  const file = getCacheFile('10', dataDir);
  await fs.writeFile(file, JSON.stringify({ channelId: '10', url: 'https://example.test/old.m3u8' }));

  // A newer capture replaced the URL: the stale failure report must be ignored.
  assert.equal(await markCacheFailed('10', 'https://example.test/dead.m3u8', { dataDir }), false);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).failedAt, undefined);

  assert.equal(await markCacheFailed('10', 'https://example.test/old.m3u8', { dataDir }), true);
  const flagged = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.ok(Number.isFinite(flagged.failedAt) && flagged.failedAt > 0);
  assert.equal(flagged.url, 'https://example.test/old.m3u8');
});
