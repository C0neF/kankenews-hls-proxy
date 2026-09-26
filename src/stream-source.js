const { decodeUrl } = require('./signing');
const { isAllowedSegmentUrl } = require('./segment-policy');
const { parseStreamTiming, STREAM_SAFETY_MS } = require('./stream-lifetime');

const DONOR_MEMO_TTL_MS = 30 * 60 * 1000;
const SCAN_DAYS_PER_TRY = 2;

function parseStreamAddress(address, now = Date.now()) {
  if (typeof address !== 'string' || !address) return null;
  try {
    const url = new URL(address.startsWith('https://') ? address : decodeUrl(address));
    if (!isAllowedSegmentUrl(url.href) || !/\.m3u8$/i.test(url.pathname)) return null;
    const timing = parseStreamTiming(url.href, now);
    if (timing.exp != null && timing.exp * 1000 <= now + STREAM_SAFETY_MS) return null;
    url.searchParams.delete('start');
    url.searchParams.delete('end');
    return {
      url: url.href,
      ...timing,
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
  const hasEnded = p => Number(p.end_time) > 0 && Number(p.end_time) <= seconds;
  const sportsNews = p => String(channelId) === '10' && /\u4f53\u80b2\u65b0\u95fb/.test(p.name || '');
  return programs.filter(p => {
    if (!p?.id || Number(p.is_shield) === 1 || Number(p.is_deleted) === 1 || Number(p.isOutDate) === 1) return false;
    if (p.start_time && Number(p.start_time) > seconds) return false;
    const isCurrent = Number(p.start_time) <= seconds && Number(p.end_time) > seconds;
    return canReview(p) || isCurrent;
  }).sort((a, b) =>
    Number(canReview(b)) - Number(canReview(a)) ||
    Number(hasEnded(b)) - Number(hasEnded(a)) ||
    Number(sportsNews(b)) - Number(sportsNews(a)) ||
    Number(b.start_time || 0) - Number(a.start_time || 0)
  );
}

function compareStreams(a, b) {
  const aHasExpiry = Number.isFinite(a.exp);
  const bHasExpiry = Number.isFinite(b.exp);
  return Number(bHasExpiry) - Number(aHasExpiry) ||
    (b.exp ?? 0) - (a.exp ?? 0) ||
    Number(b.sourceType === 'shift_address') - Number(a.sourceType === 'shift_address');
}

async function resolveStreamSource({
  channelId, apiGet, validateStream, now = Date.now, log = () => {}, timeoutMs = 120000,
  sourceState = {}, previousCache = null,
}) {
  channelId = String(channelId);
  const today = programDate(now(), 0);
  if (sourceState.channelId !== channelId) {
    Object.assign(sourceState, { channelId, donor: null, nextDay: 1, scanDate: today });
    if (String(previousCache?.channelId) === channelId && previousCache.programId != null &&
        previousCache.sourceType === 'shift_address' && Number.isFinite(previousCache.capturedAt)) {
      sourceState.donor = { id: previousCache.programId, at: previousCache.capturedAt * 1000 };
    }
  }
  if (sourceState.scanDate !== today) {
    sourceState.scanDate = today;
    sourceState.nextDay = 1;
  }
  const deadline = now() + timeoutMs;
  let liveDeadline = Infinity;
  let wafHit = false;
  const triedUrls = new Set();
  const triedPrograms = new Set();
  const expired = () => wafHit || now() >= Math.min(deadline, liveDeadline);

  function finish(stream) {
    if (!stream || !parseStreamAddress(stream.url, now())) return null;
    if (stream.sourceType === 'shift_address') {
      sourceState.nextDay = 1;
      if (stream.programId != null) sourceState.donor = { id: stream.programId, at: now() };
    }
    return stream;
  }

  async function request(endpoint, params) {
    if (expired()) return null;
    try {
      const response = await apiGet(`/content/pc/tv/${endpoint}`, params);
      if (Number(response?.code) === 1000 && response.result) return response.result;
      log(`${endpoint}: API code ${response?.code ?? 'unknown'}`);
    } catch (error) {
      log(`${endpoint}: ${error.message}`);
      if (error && (error.isWaf || /upstream WAF block/.test(String(error.message || '')))) {
        wafHit = true;
        log('WAF cooldown: stop further API for this capture.');
      }
    }
    return null;
  }

  async function tryDetail(detail, source, programId) {
    if (!detail || expired()) return null;
    const detailChannelIds = [detail.channel_id, detail.channel_info?.id, source === 'channel/detail' ? detail.id : null];
    if (detailChannelIds.some(id => id != null && String(id) !== channelId)) return null;
    const candidates = [];
    for (const field of ['shift_address', 'live_address']) {
      for (const info of [detail.channel_info, detail]) {
        const stream = parseStreamAddress(info?.[field], now());
        if (stream) candidates.push({ ...stream, source, sourceType: field, ...(programId != null ? { programId } : {}) });
      }
    }
    for (const stream of candidates.sort(compareStreams)) {
      if (triedUrls.has(stream.url) || expired()) continue;
      triedUrls.add(stream.url);
      try {
        if (await validateStream(stream.url, log) && parseStreamAddress(stream.url, now())) {
          return stream;
        }
        log(`${source} ${stream.sourceType}: playlist unavailable`);
      } catch (error) {
        log(`${source} ${stream.sourceType}: ${error.message}`);
      }
    }
    return null;
  }

  let liveFallback = null;
  function rememberLive(stream) {
    if (!liveFallback) liveDeadline = now() + 15000;
    if (!liveFallback || compareStreams(stream, liveFallback) < 0) liveFallback = stream;
  }

  const donor = sourceState.donor;
  sourceState.donor = null;
  if (donor && now() >= donor.at && now() - donor.at < DONOR_MEMO_TTL_MS) {
    log(`Reusing source program ${donor.id}.`);
    triedPrograms.add(String(donor.id));
    const result = await request('program/detail', { channel_program_id: donor.id });
    const stream = await tryDetail(result, 'program/detail', donor.id);
    if (stream?.sourceType === 'shift_address') return finish(stream);
    if (stream) rememberLive(stream);
  }

  const detail = await request('channel/detail', { channel_id: channelId });
  const direct = await tryDetail(detail, 'channel/detail');
  if (direct) return finish(liveFallback && compareStreams(liveFallback, direct) < 0 ? liveFallback : direct);

  log('Channel URL unavailable; checking program details.');
  const firstDay = sourceState.nextDay >= 1 && sourceState.nextDay <= 7 ? sourceState.nextDay : 1;
  const days = [0];
  for (let day = firstDay; day <= 7 && day < firstDay + SCAN_DAYS_PER_TRY; day++) days.push(day);
  for (const day of days) {
    if (expired()) break;
    const date = programDate(now(), day);
    const list = await request('programs', { channel_id: channelId, date });
    // Advance even if a date fails, so a bad day cannot starve older source programs.
    if (day > 0) sourceState.nextDay = day === 7 ? 1 : day + 1;
    for (const program of getProgramCandidates(list?.programs, channelId, now())) {
      if (expired()) break;
      if (triedPrograms.has(String(program.id))) continue;
      triedPrograms.add(String(program.id));
      const result = await request('program/detail', { channel_program_id: program.id });
      const stream = await tryDetail(result, 'program/detail', program.id);
      if (stream?.sourceType === 'shift_address') {
        if (!liveFallback || compareStreams(stream, liveFallback) <= 0) return finish(stream);
      } else if (stream) {
        rememberLive(stream);
      }
    }
  }
  if (expired()) log('Capture time limit reached.');
  return finish(liveFallback);
}

module.exports = { parseStreamAddress, programDate, getProgramCandidates, resolveStreamSource };
