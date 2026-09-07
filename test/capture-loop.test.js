const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { needsCapture, captureDueChannels } = require('../src/capture-loop');
const { getCacheFile } = require('../src/cache-store');

const NOW = Date.parse('2026-09-07T12:00:00Z');

test('capture refreshes early for short-lived tokens and retains the configured maximum interval', () => {
  const cache = { url: 'https://example.test/index.m3u8', capturedAt: NOW / 1000, exp: NOW / 1000 + 1800 };
  assert.equal(needsCapture(null, NOW), true);
  assert.equal(needsCapture(cache, NOW + 1499000), false);
  assert.equal(needsCapture(cache, NOW + 1500000), true);
  assert.equal(needsCapture({ ...cache, exp: null }, NOW + 36000000), true);
  assert.equal(needsCapture({ ...cache, exp: null }, NOW + 35999000), false);
  assert.equal(needsCapture(cache, NOW + 60000, 60000), true);
});

test('failed channels retry after a minute while valid channels are skipped', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-capture-loop-'));
  t.after(async () => {
    await fs.unlink(getCacheFile('1', dataDir));
    await fs.unlink(getCacheFile('10', dataDir));
    await fs.rmdir(dataDir);
  });
  const healthy = { url: 'https://example.test/good.m3u8', capturedAt: NOW / 1000, exp: NOW / 1000 + 43200 };
  const old = { ...healthy, exp: NOW / 1000 + 100 };
  await fs.writeFile(getCacheFile('1', dataDir), JSON.stringify(healthy));
  await fs.writeFile(getCacheFile('10', dataDir), JSON.stringify(old));
  let time = NOW;
  const attempts = [];
  const options = {
    channelIds: ['1', '10', '11'], dataDir, now: () => time, nextAttempts: new Map(),
    captureFn: async ({ channelId }) => { attempts.push(channelId); if (channelId === '10') throw new Error('temporary failure'); return null; },
  };
  await captureDueChannels(options);
  assert.deepEqual(attempts, ['10', '11']);
  time += 59000;
  await captureDueChannels(options);
  assert.deepEqual(attempts, ['10', '11']);
  time += 1000;
  await captureDueChannels(options);
  assert.deepEqual(attempts, ['10', '11', '10', '11']);
  assert.deepEqual(JSON.parse(await fs.readFile(getCacheFile('10', dataDir), 'utf8')), old);
});
