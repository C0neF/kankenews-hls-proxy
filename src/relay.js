/**
 * relay.js - Cloudflare Worker 中转
 *
 *   /p/api/<path>          → https://kapi.kankanews.com/<path>
 *   /p/hls/?u=<urlencoded> → m3u8/ts 代拉
 *
 * 环境变量:
 *   KK_RELAY_BASE  媒体中转入口, 默认 https://kk.conef1.ggff.net; 空字符串则直连 CDN
 *   KK_RELAY_API   API 是否走中转: 默认 off (直连 kapi, 避开 Worker 出口被 WAF)
 *                  设为 1/on 使用 KK_RELAY_BASE, 或填完整中转地址
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

function getApiRelayBase() {
  const raw = process.env.KK_RELAY_API;
  if (raw === undefined) return '';
  const v = String(raw).trim();
  if (!v || v === '0' || v.toLowerCase() === 'off') return '';
  if (v === '1' || v.toLowerCase() === 'on') return getRelayBase();
  return normalizeBase(v);
}

function toApiUrl(path) {
  const p = String(path || '');
  const suffix = p.startsWith('/') ? p : `/${p}`;
  const base = getApiRelayBase();
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
  getApiRelayBase,
  isLocalHostname,
  toApiUrl,
  toUpstreamMediaUrl,
  isRelayMediaUrl,
  fromUpstreamMediaUrl,
};
