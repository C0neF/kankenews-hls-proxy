const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildSegmentResponseHeaders,
  isAllowedSegmentUrl,
  shouldCacheSegment,
} = require('../src/segment-policy');

test('segment proxy allows only configured HTTPS hosts', () => {
  assert.equal(isAllowedSegmentUrl('https://volc-stream.kksmg.com/live/1.ts'), true);
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
