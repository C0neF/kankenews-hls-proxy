const { decodeUrl, parseJwt } = require('./signing');
const { isAllowedSegmentUrl } = require('./segment-policy');

function parseStreamAddress(address, now = Date.now()) {
  if (typeof address !== 'string' || !address) return null;
  try {
    const url = new URL(address.startsWith('https://') ? address : decodeUrl(address));
    if (!isAllowedSegmentUrl(url.href) || !/\.m3u8$/i.test(url.pathname)) return null;
    const token = url.searchParams.get('token');
    const payload = token ? parseJwt(token) : null;
    if (token && (!Number.isFinite(payload?.exp) || payload.exp <= now / 1000 + 60)) return null;
    url.searchParams.delete('start');
    url.searchParams.delete('end');
    return {
      url: url.href,
      exp: payload?.exp ?? null,
      streamName: payload?.stream_name ?? null,
      userIp: payload?.user_ip ?? null,
    };
  } catch {
    return null;
  }
}

function programDate(now, daysAgo) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(now - daysAgo * 86400000));
}

function getProgramCandidates(programs, channelId, now) {
  if (!Array.isArray(programs)) return [];
  const seconds = now / 1000;
  const canReview = p => Number(p.is_review) === 1 || Number(p.can_review) === 1;
  const sportsNews = p => String(channelId) === '10' && /\u4f53\u80b2\u65b0\u95fb/.test(p.name || '');
  return programs.filter(p => {
    if (!p?.id || Number(p.is_shield) === 1 || Number(p.is_deleted) === 1) return false;
    if (p.start_time && Number(p.start_time) > seconds) return false;
    const isCurrent = Number(p.start_time) <= seconds && Number(p.end_time) > seconds;
    return canReview(p) || isCurrent;
  }).sort((a, b) =>
    Number(canReview(b)) - Number(canReview(a)) ||
    Number(sportsNews(b)) - Number(sportsNews(a)) ||
    Number(b.start_time || 0) - Number(a.start_time || 0)
  );
}

async function resolveStreamSource({ channelId, apiGet, validateStream, now = Date.now, log = () => {}, timeoutMs = 120000 }) {
  const deadline = now() + timeoutMs;
  let liveDeadline = Infinity;
  const triedUrls = new Set();
  const triedPrograms = new Set();
  const expired = () => now() >= Math.min(deadline, liveDeadline);

  async function request(endpoint, params) {
    if (expired()) return null;
    try {
      const response = await apiGet(`/content/pc/tv/${endpoint}`, params);
      if (Number(response?.code) === 1000 && response.result) return response.result;
      log(`${endpoint}: API code ${response?.code ?? 'unknown'}`);
    } catch (error) {
      log(`${endpoint}: ${error.message}`);
    }
    return null;
  }

  async function tryDetail(detail, source, programId) {
    if (!detail || expired()) return null;
    const detailChannelId = detail.channel_id ?? detail.channel_info?.id ?? (source === 'channel/detail' ? detail.id : null);
    if (detailChannelId != null && String(detailChannelId) !== String(channelId)) return null;
    // Prefer the longer-lived shift URL, but try live if it is missing or unusable.
    for (const field of ['shift_address', 'live_address']) {
      for (const info of [detail.channel_info, detail]) {
        const stream = parseStreamAddress(info?.[field], now());
        if (!stream || triedUrls.has(stream.url) || expired()) continue;
        triedUrls.add(stream.url);
        try {
          if (await validateStream(stream.url)) {
            return { ...stream, source, sourceType: field, ...(programId != null ? { programId } : {}) };
          }
          log(`${source} ${field}: playlist unavailable`);
        } catch (error) {
          log(`${source} ${field}: ${error.message}`);
        }
      }
    }
    return null;
  }

  const detail = await request('channel/detail', { channel_id: String(channelId) });
  const direct = await tryDetail(detail, 'channel/detail');
  if (direct) return direct;

  log('Channel URL unavailable; checking program details.');
  let liveFallback = null;
  for (let day = 0; day <= 7 && !expired(); day++) {
    const date = programDate(now(), day);
    const list = await request('programs', { channel_id: String(channelId), date });
    for (const program of getProgramCandidates(list?.programs, channelId, now())) {
      if (expired()) break;
      if (triedPrograms.has(String(program.id))) continue;
      triedPrograms.add(String(program.id));
      const result = await request('program/detail', { channel_program_id: program.id });
      const stream = await tryDetail(result, 'program/detail', program.id);
      if (stream?.sourceType === 'shift_address') return stream;
      if (stream) {
        if (!liveFallback) liveDeadline = now() + 15000;
        if (!liveFallback || (stream.exp ?? Infinity) > (liveFallback.exp ?? Infinity)) liveFallback = stream;
      }
    }
  }
  if (expired()) log('Capture time limit reached.');
  return liveFallback && parseStreamAddress(liveFallback.url, now()) ? liveFallback : null;
}

module.exports = { parseStreamAddress, programDate, getProgramCandidates, resolveStreamSource };
