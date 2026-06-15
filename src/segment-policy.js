const DEFAULT_ALLOWED_SEGMENT_HOSTS = ['volc-stream.kksmg.com'];
const MAX_CACHEABLE_SEGMENT_BYTES = 10 * 1024 * 1024;

function getAllowedSegmentHosts(value = process.env.ALLOWED_SEGMENT_HOSTS) {
  if (!value) return DEFAULT_ALLOWED_SEGMENT_HOSTS;
  return value
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

function isAllowedSegmentUrl(rawUrl, allowedHosts = getAllowedSegmentHosts()) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && allowedHosts.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function shouldCacheSegment({ hasRange, statusCode, contentLength, maxBytes = MAX_CACHEABLE_SEGMENT_BYTES }) {
  return !hasRange && statusCode === 200 && contentLength > 0 && contentLength < maxBytes;
}

function buildSegmentResponseHeaders({
  contentType,
  acceptRanges,
  contentLength,
  contentRange,
  cacheControl = 'public, max-age=300',
  xCache = 'MISS',
}) {
  const headers = {
    'Content-Type': contentType || 'video/mp2t',
    'Accept-Ranges': acceptRanges || 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': cacheControl,
    'X-Cache': xCache,
  };

  if (contentLength != null) headers['Content-Length'] = contentLength;
  if (contentRange) headers['Content-Range'] = contentRange;

  return headers;
}

module.exports = {
  DEFAULT_ALLOWED_SEGMENT_HOSTS,
  MAX_CACHEABLE_SEGMENT_BYTES,
  buildSegmentResponseHeaders,
  getAllowedSegmentHosts,
  isAllowedSegmentUrl,
  shouldCacheSegment,
};
