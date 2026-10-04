const assert = require('node:assert/strict');
const test = require('node:test');
const { createApiQueue, API_MIN_INTERVAL_MS } = require('../src/api-queue');

test('API calls are serialized, spaced by the configured interval and continue after a rejected request', async () => {
  let time = 0;
  const events = [];
  const queue = createApiQueue({ now: () => time, wait: async ms => { time += ms; } });
  const results = await Promise.allSettled([0, 1, 2].map(id => queue(async () => {
    events.push({ id, at: time });
    await Promise.resolve();
    time += 100;
    if (id === 1) throw new Error('request failed');
    return id;
  })));
  assert.deepEqual(events, [
    { id: 0, at: 0 },
    { id: 1, at: API_MIN_INTERVAL_MS },
    { id: 2, at: API_MIN_INTERVAL_MS * 2 },
  ]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected', 'fulfilled']);
});

test('slow API calls already satisfy the interval without an extra delay', async () => {
  let time = 0;
  const queue = createApiQueue({ now: () => time, wait: async () => assert.fail('unexpected delay') });
  const first = queue(async () => { time += 1200; });
  const second = queue(async () => time);
  await first;
  assert.equal(await second, 1200);
});

test('the interval can be raised through API_MIN_INTERVAL_MS', async () => {
  process.env.API_MIN_INTERVAL_MS = '2500';
  try {
    let time = 0;
    const events = [];
    const queue = createApiQueue({ now: () => time, wait: async ms => { time += ms; } });
    await queue(async () => { events.push(time); });
    await queue(async () => { events.push(time); });
    assert.deepEqual(events, [0, 2500]);
  } finally {
    delete process.env.API_MIN_INTERVAL_MS;
  }
});

test('jitter only ever adds spacing on top of the interval', async () => {
  const originalRandom = Math.random;
  Math.random = () => 0.5;
  try {
    let time = 0;
    const events = [];
    const queue = createApiQueue({ now: () => time, wait: async ms => { time += ms; }, intervalMs: 1000, jitterMs: 400 });
    await queue(async () => { events.push(time); });
    await queue(async () => { events.push(time); });
    assert.deepEqual(events, [0, 1200]);
  } finally {
    Math.random = originalRandom;
  }
});
