const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { needsCapture, captureDueChannels, wafBackoffDelay, WAF_BACKOFF_STEPS_MS } = require('../src/capture-loop');
const { getCacheFile } = require('../src/cache-store');

const NOW = Date.parse('2026-09-07T12:00:00Z');

test('capture refreshes early for short-lived tokens and retains the configured maximum interval', () => {
  const cache = { url: 'https://example.test/index.m3u8', capturedAt: NOW / 1000, exp: NOW / 1000 + 1800 };
  assert.equal(needsCapture(null, NOW), true);
  assert.equal(needsCapture(cache, NOW + 1679999), false);
  assert.equal(needsCapture(cache, NOW + 1680000), true);
  assert.equal(needsCapture({ ...cache, exp: null }, NOW + 1079999), false);
  assert.equal(needsCapture({ ...cache, exp: null }, NOW + 1080000), true);
  assert.equal(needsCapture({ ...cache, exp: NOW / 1000 + 86400 }, NOW + 36000000), true);
  assert.equal(needsCapture({ ...cache, exp: NOW / 1000 + 86400 }, NOW + 35999000), false);
  assert.equal(needsCapture(cache, NOW + 60000, 60000), true);
  assert.equal(needsCapture({ ...cache, exp: NOW / 1000 + 90 }, NOW + 74000), false);
  assert.equal(needsCapture({ ...cache, exp: NOW / 1000 + 90 }, NOW + 75000), true);
  assert.equal(needsCapture({ ...cache, failedAt: NOW / 1000 - 60 }, NOW), true);
  assert.equal(needsCapture({ ...cache, failedAt: NOW / 1000 - 601 }, NOW), false);
});

test('failed channels retry after a minute while valid channels are skipped', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-capture-loop-'));
  t.after(async () => {
    await fs.unlink(getCacheFile('1', dataDir));
    await fs.unlink(getCacheFile('10', dataDir));
    await fs.rmdir(dataDir);
  });
  const healthy = { url: 'https://example.test/good.m3u8', capturedAt: NOW / 1000, exp: NOW / 1000 + 43200 };
  const old = { ...healthy, capturedAt: NOW / 1000 - 1700, exp: NOW / 1000 + 100 };
  await fs.writeFile(getCacheFile('1', dataDir), JSON.stringify(healthy));
  await fs.writeFile(getCacheFile('10', dataDir), JSON.stringify(old));
  let time = NOW;
  const attempts = [];
  const states = new Map();
  const options = {
    channelIds: ['1', '10', '11'], dataDir, now: () => time, nextAttempts: new Map(), sourceStates: new Map(),
    captureFn: async ({ channelId, sourceState, previousCache }) => {
      attempts.push(channelId);
      if (states.has(channelId)) assert.equal(sourceState, states.get(channelId));
      states.set(channelId, sourceState);
      if (channelId === '10') {
        assert.deepEqual(previousCache, old);
        throw new Error('temporary failure');
      }
      return null;
    },
  };
  await captureDueChannels(options);
  assert.deepEqual(attempts, ['10', '11']);
  time += 59000;
  await captureDueChannels(options);
  assert.deepEqual(attempts, ['10', '11']);
  time += 1000;
  await captureDueChannels(options);
  assert.deepEqual(attempts, ['10', '11', '10', '11']);
  assert.notEqual(states.get('10'), states.get('11'));
  assert.deepEqual(JSON.parse(await fs.readFile(getCacheFile('10', dataDir), 'utf8')), old);
});

test('WAF failures escalate the quiet period and gate every channel', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-waf-backoff-'));
  t.after(async () => { await fs.rmdir(dataDir); });

  let time = NOW;
  const wafState = { strikes: 0, until: 0 };
  const attempts = [];
  const options = {
    channelIds: ['1', '2'], dataDir, now: () => time, nextAttempts: new Map(),
    sourceStates: new Map(), wafState,
    captureFn: async ({ channelId, sourceState }) => {
      attempts.push(channelId);
      if (channelId === '1') {
        sourceState.wafHitAt = time + 1;
        return null;
      }
      return null;
    },
  };

  await captureDueChannels(options);
  // The first WAF hit protects every later channel in the same round.
  assert.deepEqual(attempts, ['1']);
  assert.equal(wafState.strikes, 1);
  assert.equal(wafState.until, NOW + 300000);
  assert.equal(options.nextAttempts.get('1'), NOW + 300000);

  // During the quiet period no channel is touched, not even the unaffected one.
  time += 60000;
  await captureDueChannels(options);
  assert.deepEqual(attempts, ['1']);

  // The gated probe escalates to the second step.
  time = NOW + 300000;
  await captureDueChannels(options);
  assert.deepEqual(attempts, ['1', '1']);
  assert.equal(wafState.strikes, 2);
  assert.equal(wafState.until, time + 900000);

  // A successful capture resets the strikes and reopens the gate.
  options.captureFn = async ({ channelId }) => {
    attempts.push(channelId);
    return { url: 'https://example.test/fresh.m3u8', capturedAt: time / 1000 };
  };
  time = wafState.until;
  await captureDueChannels(options);
  assert.deepEqual(attempts, ['1', '1', '1', '2']);
  assert.equal(wafState.strikes, 0);
  assert.equal(wafState.until, 0);
  assert.equal(options.nextAttempts.get('1'), time + 60000);
  assert.equal(options.nextAttempts.get('2'), time + 60000);
});

test('WAF backoff delays escalate and cap at the last step', () => {
  assert.deepEqual([1, 2, 3].map(strike => wafBackoffDelay(strike)), WAF_BACKOFF_STEPS_MS);
  assert.equal(wafBackoffDelay(0), WAF_BACKOFF_STEPS_MS[0]);
  assert.equal(wafBackoffDelay(99), WAF_BACKOFF_STEPS_MS.at(-1));
});
