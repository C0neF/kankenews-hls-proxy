const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');

const DEFAULT_ALLOWED_SEGMENT_HOSTS = [
  'volc-stream.kksmg.com',
  'ws-channels.kksmg.com',
  'tencent-stream.kksmg.com',
];
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

function createPlaylistSegmentAuthorizer() {
  const key = randomBytes(32);
  const signatureFor = url => createHmac('sha256', key).update(url).digest('hex');
  function isWangsuSegment(rawUrl) {
    try {
      const url = new URL(rawUrl);
      return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
        /^[a-z0-9-]+\.100ycdn\.com$/i.test(url.hostname);
    } catch {
      return false;
    }
  }
  function verify(targetUrl, signature) {
    if (!isWangsuSegment(targetUrl) || !/^[a-f0-9]{64}$/.test(signature || '')) return false;
    return timingSafeEqual(Buffer.from(signatureFor(targetUrl), 'hex'), Buffer.from(signature, 'hex'));
  }
  return {
    sign(targetUrl, playlistUrl, parentSignature) {
      try {
        const trustedRoot = new URL(playlistUrl).hostname === 'ws-channels.kksmg.com' && isAllowedSegmentUrl(playlistUrl);
        if ((!trustedRoot && !verify(playlistUrl, parentSignature)) || !isWangsuSegment(targetUrl)) return null;
        return signatureFor(targetUrl);
      } catch {
        return null;
      }
    },
    verify,
  };
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
  createPlaylistSegmentAuthorizer,
  getAllowedSegmentHosts,
  isAllowedSegmentUrl,
  shouldCacheSegment,
};
