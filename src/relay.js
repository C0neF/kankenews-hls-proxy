/**
 * relay.js - 统一走 Cloudflare Worker 中转，降低源站按出口 IP 拒绝的概率。
 *
 * 环境变量 KK_RELAY_BASE:
 *   - 默认 https://kk.conef1.ggff.net
 *   - 设为空字符串则直连上游 (kapi / CDN)
 *
 * Worker 路由:
 *   /p/api/<path>          → https://kapi.kankanews.com/<path>
 *   /p/hls/?u=<urlencoded> → m3u8/ts 代拉, m3u8 内地址改写回 Worker
 */

const DEFAULT_RELAY_BASE = 'https://kk.conef1.ggff.net';
const DIRECT_API_BASE = 'https://kapi.kankanews.com';

function normalizeBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function getRelayBase() {
  const raw = process.env.KK_RELAY_BASE;
  if (raw === undefined) return DEFAULT_RELAY_BASE;
  return normalizeBase(raw);
}

function toApiUrl(path) {
  const p = String(path || '');
  const suffix = p.startsWith('/') ? p : `/${p}`;
  const base = getRelayBase();
  return base ? `${base}/p/api${suffix}` : `${DIRECT_API_BASE}${suffix}`;
}

function isLocalHostname(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'localhost' || h === '::1' || h === '[::1]' ||
    h.endsWith('.localhost') || /^127\./.test(h) ||
    /^10\./.test(h) || /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(h);
}

function toUpstreamMediaUrl(rawUrl) {
  const href = String(rawUrl || '');
  const base = getRelayBase();
  if (!base || !/^https?:\/\//i.test(href)) return href;
  try {
    const u = new URL(href);
    if (isLocalHostname(u.hostname)) return href;
  } catch {
    return href;
  }
  return `${base}/p/hls/?u=${encodeURIComponent(href)}`;
}

function isRelayMediaUrl(url) {
  const base = getRelayBase();
  return !!base && String(url || '').startsWith(`${base}/p/hls/`);
}

function fromUpstreamMediaUrl(url) {
  const href = String(url || '');
  if (!isRelayMediaUrl(href)) return href;
  try {
    const parsed = new URL(href);
    const u = parsed.searchParams.get('u');
    return u ? u : href;
  } catch {
    return href;
  }
}

module.exports = {
  DEFAULT_RELAY_BASE,
  DIRECT_API_BASE,
  getRelayBase,
  isLocalHostname,
  toApiUrl,
  toUpstreamMediaUrl,
  isRelayMediaUrl,
  fromUpstreamMediaUrl,
};
