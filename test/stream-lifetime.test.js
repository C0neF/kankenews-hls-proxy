const assert = require('node:assert/strict');
const test = require('node:test');
const {
  isStreamUsable, parseStreamTiming, streamExpiresAt, streamRenewalMargin,
} = require('../src/stream-lifetime');

const NOW = Date.parse('2026-09-07T12:00:00Z');
const ROOT = 'https://volc-stream.kksmg.com/live/wxty/index.m3u8';
const jwt = payload => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;

test('the earliest JWT or CDN expiry wins, while stream metadata and issue time survive', () => {
  const token = jwt({ exp: NOW / 1000 + 7200, iat: NOW / 1000, stream_name: 'wxty', user_ip: '192.0.2.1' });
  const auth = jwt({ exp: NOW / 1000 + 3600 });
  const result = parseStreamTiming(`${ROOT}?token=${token}&auth=${auth}&volcTime=${NOW / 1000 + 1800}`, NOW);
  assert.deepEqual(result, {
    exp: NOW / 1000 + 1800, issuedAt: NOW / 1000, streamName: 'wxty', userIp: '192.0.2.1',
  });
  assert.equal(parseStreamTiming(`${ROOT}?auth=${auth}`, NOW).exp, NOW / 1000 + 3600);
});

test('CDN expiry names are case insensitive and accept seconds and milliseconds', () => {
  for (const key of ['volcTime', 'volc_time', 'expires', 'expire_time', 'expiredtime', 'wsTime', 'ws_time', 'exper', 'auth_deadline', 'token_expiry']) {
    for (const value of [NOW / 1000 + 300, NOW + 300000]) {
      assert.equal(parseStreamTiming(`${ROOT}?${key}=${value}`, NOW).exp, NOW / 1000 + 300, key);
    }
  }
});

test('old expiry values remain expired instead of becoming addresses with unknown lifetimes', () => {
  const old = NOW / 1000 - 2 * 86400;
  assert.equal(parseStreamTiming(`${ROOT}?auth=${jwt({ exp: old })}`, NOW).exp, old);
  assert.equal(parseStreamTiming(`${ROOT}?expire=${old}`, NOW).exp, old);
});

test('replay windows, durations, malformed tokens and unrelated timestamps are not expiry times', () => {
  const url = `${ROOT}?token=opaque&auth=a.bad.c&expires=60&start=${NOW / 1000}&end=${NOW / 1000 + 300}&other=${NOW + 300000}`;
  assert.equal(parseStreamTiming(url, NOW).exp, null);
  assert.equal(parseStreamTiming(`${ROOT}?expires=${NOW / 1000 + 61 * 86400}`, NOW).exp, null);
  assert.equal(parseStreamTiming('not a URL', NOW).exp, null);
});

test('addresses without expiry last twenty minutes and stop being served inside the safety margin', () => {
  const cache = { url: ROOT, exp: null, capturedAt: NOW / 1000 };
  assert.equal(streamExpiresAt(cache), NOW + 1200000);
  assert.equal(isStreamUsable(cache, NOW + 1194999), true);
  assert.equal(isStreamUsable(cache, NOW + 1195000), false);
  assert.equal(isStreamUsable({ url: ROOT }, NOW), false);
  assert.equal(isStreamUsable(null, NOW), false);
});

test('legacy cache metadata cannot extend an earlier expiry encoded in the URL', () => {
  const cache = { url: `${ROOT}?expires=${NOW / 1000 + 300}`, exp: NOW / 1000 + 3600, capturedAt: NOW / 1000 };
  assert.equal(streamExpiresAt(cache), NOW + 300000);
  assert.equal(isStreamUsable(cache, NOW + 295000), false);
});

test('renewal adapts to short-lived tokens and uses issue time instead of resetting their lifetime', () => {
  const cache = { url: ROOT, capturedAt: NOW / 1000 };
  assert.equal(streamRenewalMargin({ ...cache, exp: NOW / 1000 + 90 }), 15000);
  assert.equal(streamRenewalMargin({ ...cache, exp: NOW / 1000 + 300 }), 45000);
  assert.equal(streamRenewalMargin({ ...cache, exp: NOW / 1000 + 3600 }), 120000);
  assert.equal(streamRenewalMargin({ ...cache, exp: null }), 120000);
  assert.equal(streamRenewalMargin({ ...cache, capturedAt: NOW / 1000 + 270, issuedAt: NOW / 1000, exp: NOW / 1000 + 300 }), 45000);
});
