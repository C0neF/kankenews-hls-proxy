const { parseJwt } = require('./signing');

const STREAM_NO_EXP_TTL_MS = 20 * 60 * 1000;
const STREAM_RENEW_MARGIN_MS = 120000;
const STREAM_SAFETY_MS = 5000;
const EXPIRY_KEYS = new Set([
  'volctime', 'volc_time', 'expire', 'expires', 'expiretime',
  'expire_time', 'expiredtime', 'wstime', 'ws_time', 'exper',
]);

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

// Cache timestamps stay in seconds, including expiry parameters supplied in milliseconds.
function parseStreamTiming(rawUrl, now = Date.now()) {
  const expiries = [];
  let payload = null;
  try {
    const url = new URL(rawUrl);
    const token = url.searchParams.get('token');
    if (token?.split('.').length === 3) payload = parseJwt(token);
    if (positiveNumber(payload?.exp)) expiries.push(payload.exp);
    for (const [key, value] of url.searchParams) {
      if (value.split('.').length === 3) {
        const jwt = parseJwt(value);
        if (positiveNumber(jwt?.exp)) {
          expiries.push(jwt.exp);
          if (!payload) payload = jwt;
        }
      }
      const name = key.toLowerCase();
      if (!EXPIRY_KEYS.has(name) && !/(expire|expiry|deadline)/.test(name)) continue;
      const numeric = Number(value);
      const seconds = numeric >= 1e12 ? numeric / 1000 : numeric >= 1e8 ? numeric : null;
      // Avoid interpreting durations and unrelated counters as epoch timestamps.
      if (Number.isFinite(seconds) && seconds <= now / 1000 + 60 * 86400) expiries.push(seconds);
    }
  } catch {}
  return {
    exp: expiries.length ? Math.min(...expiries) : null,
    issuedAt: positiveNumber(payload?.iat) ? payload.iat : null,
    streamName: payload?.stream_name ?? null,
    userIp: payload?.user_ip ?? null,
  };
}

function streamExpiresAt(cache) {
  if (!cache?.url) return null;
  const expiries = [cache.exp, parseStreamTiming(cache.url).exp].filter(positiveNumber);
  if (expiries.length) return Math.min(...expiries) * 1000;
  if (positiveNumber(cache.capturedAt)) return cache.capturedAt * 1000 + STREAM_NO_EXP_TTL_MS;
  return null;
}

function isStreamUsable(cache, now = Date.now()) {
  const expiry = streamExpiresAt(cache);
  return expiry != null && now < expiry - STREAM_SAFETY_MS;
}

function streamRenewalMargin(cache) {
  const expiry = streamExpiresAt(cache);
  if (expiry == null) return STREAM_RENEW_MARGIN_MS;
  const anchor = positiveNumber(cache.issuedAt) ? cache.issuedAt * 1000 : cache.capturedAt * 1000;
  if (!Number.isFinite(anchor) || anchor >= expiry) return STREAM_RENEW_MARGIN_MS;
  const lifetime = Math.max(Math.min(expiry - anchor, 3600000), 60000);
  return Math.min(STREAM_RENEW_MARGIN_MS, Math.max(lifetime * 0.15, 15000));
}

module.exports = {
  STREAM_NO_EXP_TTL_MS,
  STREAM_SAFETY_MS,
  isStreamUsable,
  parseStreamTiming,
  streamExpiresAt,
  streamRenewalMargin,
};
