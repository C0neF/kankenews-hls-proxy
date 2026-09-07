const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildSegmentResponseHeaders,
  createPlaylistSegmentAuthorizer,
  isAllowedSegmentUrl,
  shouldCacheSegment,
} = require('../src/segment-policy');

test('segment proxy allows only configured HTTPS hosts', () => {
  assert.equal(isAllowedSegmentUrl('https://volc-stream.kksmg.com/live/1.ts'), true);
  assert.equal(isAllowedSegmentUrl('https://ws-channels.kksmg.com/live/ylpd/1.ts'), true);
  assert.equal(isAllowedSegmentUrl('https://tencent-stream.kksmg.com/live/shanghaieye-1.ts'), true);
  assert.equal(isAllowedSegmentUrl('http://volc-stream.kksmg.com/live/1.ts'), false);
  assert.equal(isAllowedSegmentUrl('https://example.com/live/1.ts'), false);
  assert.equal(isAllowedSegmentUrl('not a url'), false);
});

test('segment cache skips ranged, non-200, and oversized responses', () => {
  assert.equal(shouldCacheSegment({ hasRange: false, statusCode: 200, contentLength: 1024 }), true);
  assert.equal(shouldCacheSegment({ hasRange: true, statusCode: 200, contentLength: 1024 }), false);
  assert.equal(shouldCacheSegment({ hasRange: false, statusCode: 206, contentLength: 1024 }), false);
  assert.equal(shouldCacheSegment({ hasRange: false, statusCode: 403, contentLength: 1024 }), false);
  assert.equal(shouldCacheSegment({ hasRange: false, statusCode: 200, contentLength: 0 }), false);
  assert.equal(shouldCacheSegment({ hasRange: false, statusCode: 200, contentLength: 11 * 1024 * 1024 }), false);
});

test('dynamic Wangsu segments require a signature issued for a trusted channel playlist', () => {
  const authorizer = createPlaylistSegmentAuthorizer();
  const playlist = 'https://ws-channels.kksmg.com/live/ylpd/index.m3u8';
  const segment = 'https://dynamic-node.100ycdn.com/live/ylpd/1.ts?token=example';
  assert.equal(isAllowedSegmentUrl(segment), false);
  assert.equal(authorizer.verify(segment), false);
  const signature = authorizer.sign(segment, playlist);
  assert.ok(signature);
  assert.equal(authorizer.verify(segment, signature), true);
  assert.equal(authorizer.verify(segment + '&changed=1', signature), false);
  assert.equal(authorizer.verify(segment, 'a'.repeat(64)), false);
  assert.equal(authorizer.verify(segment, 'malformed'), false);
  assert.equal(authorizer.sign(segment, 'https://example.com/index.m3u8'), null);
  assert.equal(authorizer.sign(segment, 'https://volc-stream.kksmg.com/index.m3u8'), null);
  assert.equal(authorizer.sign('https://dynamic-node.100ycdn.com.evil.test/1.ts', playlist), null);
  assert.equal(authorizer.sign('http://dynamic-node.100ycdn.com/1.ts', playlist), null);
  assert.equal(authorizer.sign('https://dynamic-node.100ycdn.com:8443/1.ts', playlist), null);
  assert.equal(authorizer.sign('https://user@dynamic-node.100ycdn.com/1.ts', playlist), null);
});

test('segment response forwards Content-Range for partial content', () => {
  const headers = buildSegmentResponseHeaders({
    contentType: 'video/mp2t',
    acceptRanges: 'bytes',
    contentLength: '100',
    contentRange: 'bytes 0-99/200',
  });

  assert.equal(headers['Content-Range'], 'bytes 0-99/200');
  assert.equal(headers['Content-Length'], '100');
});
