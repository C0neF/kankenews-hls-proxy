const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { parseStreamAddress, programDate, getProgramCandidates, resolveStreamSource } = require('../src/stream-source');
const { validateStream } = require('../src/vps-capture');
const { USER_AGENT } = require('../src/http-headers');

const NOW = Date.parse('2026-09-07T12:00:00Z');
function stream(name, exp = NOW / 1000 + 43200, host = 'volc-stream.kksmg.com') {
  const token = `header.${Buffer.from(JSON.stringify({ exp, stream_name: name })).toString('base64url')}.signature`;
  return `https://${host}/live/${name}/index.m3u8?token=${token}`;
}
const ok = result => ({ code: '1000', result });
const program = (id, extra = {}) => ({ id, is_review: 1, start_time: NOW / 1000 - 7200, end_time: NOW / 1000 - 3600, ...extra });

test('stream parsing strips only the replay window and rejects expired or unsafe URLs', () => {
  const url = stream('valid');
  const parsed = parseStreamAddress(`${url}&start=1&end=2&extra=keep`, NOW);
  assert.equal(parsed.url, `${url}&extra=keep`);
  assert.equal(parsed.streamName, 'valid');
  assert.equal(parseStreamAddress(stream('expired', NOW / 1000 - 1), NOW), null);
  assert.equal(parseStreamAddress(stream('expiring', NOW / 1000 + 59), NOW), null);
  assert.equal(parseStreamAddress('https://volc-stream.kksmg.com/live/index.m3u8?token=bad', NOW), null);
  assert.equal(parseStreamAddress(stream('wrong', undefined, 'example.com'), NOW), null);
  assert.equal(parseStreamAddress('broken RSA data', NOW), null);
});

test('live URL is tried when a shift URL is expired or fails its playlist check', async () => {
  for (const shift of [stream('expired', NOW / 1000), stream('unavailable')]) {
    const checked = [];
    const result = await resolveStreamSource({
      channelId: '10', now: () => NOW,
      apiGet: async endpoint => {
        assert.ok(endpoint.endsWith('/channel/detail'));
        return ok({ id: 10, shift_address: shift, live_address: stream('live') });
      },
      validateStream: async url => { checked.push(url); return url === stream('live'); },
    });
    assert.equal(result.url, stream('live'));
    assert.equal(result.sourceType, 'live_address');
    assert.ok(!checked.includes(stream('expired', NOW / 1000)));
  }
});

test('program fallback tries another eligible program on the same date without modifying flags', async () => {
  const list = [program(1, { is_review: 0 }), program(2), program(3)];
  const before = structuredClone(list);
  const requested = [];
  const result = await resolveStreamSource({
    channelId: '10', now: () => NOW,
    apiGet: async (endpoint, params) => {
      if (endpoint.endsWith('/channel/detail')) return ok({ id: 10 });
      if (endpoint.endsWith('/programs')) return ok({ programs: list });
      requested.push(params.channel_program_id);
      return ok({ channel_id: 10, channel_info: { shift_address: stream(String(params.channel_program_id)) } });
    },
    validateStream: async url => url === stream('3'),
  });
  assert.deepEqual(requested, [2, 3]);
  assert.deepEqual(list, before);
  assert.equal(result.programId, 3);
});

test('every configured channel can recover a source from an earlier program date', async () => {
  for (const channelId of ['1', '2', '4', '5', '9', '10', '11', '12']) {
    const dates = [];
    const result = await resolveStreamSource({
      channelId, now: () => NOW,
      apiGet: async (endpoint, params) => {
        if (endpoint.endsWith('/channel/detail')) return ok({ id: channelId });
        if (endpoint.endsWith('/programs')) {
          dates.push(params.date);
          return ok({ programs: dates.length === 3 ? [program(100)] : [] });
        }
        return ok({ channel_id: channelId, channel_info: { shift_address: stream(channelId) } });
      },
      validateStream: async () => true,
    });
    assert.equal(result.url, stream(channelId));
    assert.deepEqual(dates, ['2026-09-07', '2026-09-06', '2026-09-05']);
  }
});

test('a longer-lived past shift source is preferred over a short-lived current live source', async () => {
  for (const hasShift of [true, false]) {
    let days = 0;
    const result = await resolveStreamSource({
      channelId: '10', now: () => NOW,
      apiGet: async (endpoint, params) => {
        if (endpoint.endsWith('/channel/detail')) return ok({ id: 10 });
        if (endpoint.endsWith('/programs')) return ok({ programs: ++days === 1 ? [program(1)] : days === 2 ? [program(2)] : [] });
        if (params.channel_program_id === 1) return ok({ channel_id: 10, channel_info: { live_address: stream('short', NOW / 1000 + 1800) } });
        return ok({ channel_id: 10, channel_info: { shift_address: hasShift ? stream('long') : '' } });
      },
      validateStream: async () => true,
    });
    assert.equal(result.url, hasShift ? stream('long') : stream('short', NOW / 1000 + 1800));
    assert.equal(result.sourceType, hasShift ? 'shift_address' : 'live_address');
  }
});

test('API errors and empty program days are bounded to today plus the past seven days', async () => {
  let lists = 0;
  const result = await resolveStreamSource({
    channelId: '10', now: () => NOW,
    apiGet: async endpoint => {
      if (endpoint.endsWith('/channel/detail')) return { code: 4001 };
      lists++;
      if (lists === 1) throw new Error('timeout');
      return ok({ programs: [] });
    },
    validateStream: async () => { throw new Error('unexpected validation'); },
  });
  assert.equal(result, null);
  assert.equal(lists, 8);
});

test('a different channel source is never accepted', async () => {
  let validations = 0;
  const result = await resolveStreamSource({
    channelId: '4', now: () => NOW,
    apiGet: async endpoint => endpoint.endsWith('/channel/detail')
      ? ok({ id: 10, live_address: stream('wrong') })
      : ok({ programs: [] }),
    validateStream: async () => { validations++; return true; },
  });
  assert.equal(result, null);
  assert.equal(validations, 0);
});

test('program selection preserves permissions and excludes future, shielded and deleted programs', () => {
  const candidates = getProgramCandidates([
    program(1, { start_time: NOW / 1000 + 3600 }),
    program(2, { is_shield: 1 }),
    program(3, { is_deleted: 1 }),
    program(4, { is_review: '1' }),
    program(5, { is_review: 0, can_review: '1' }),
    program(6, { is_review: 0, end_time: NOW / 1000 + 100 }),
    program(7, { is_review: 0 }),
  ], '10', NOW);
  assert.deepEqual(candidates.map(p => p.id), [4, 5, 6]);
  assert.equal(programDate(Date.parse('2026-09-06T17:00:00Z'), 0), '2026-09-07');
});

test('capture deadline prevents further API requests', async () => {
  let time = NOW;
  let requests = 0;
  const result = await resolveStreamSource({
    channelId: '10', now: () => time, timeoutMs: 1000,
    apiGet: async () => { requests++; time += 1001; return ok({}); },
    validateStream: async () => true,
  });
  assert.equal(result, null);
  assert.equal(requests, 1);
});

test('a validated live source bounds the extra search for unavailable replay sources', async () => {
  let time = NOW;
  let lists = 0;
  let details = 0;
  const result = await resolveStreamSource({
    channelId: '4', now: () => time,
    apiGet: async endpoint => {
      if (endpoint.endsWith('/channel/detail')) return ok({ id: 4 });
      if (endpoint.endsWith('/programs')) {
        if (++lists > 1) time += 15001;
        return ok({ programs: [program(lists)] });
      }
      details++;
      return ok({ channel_id: 4, channel_info: { live_address: stream('live') } });
    },
    validateStream: async () => true,
  });
  assert.equal(result.url, stream('live'));
  assert.equal(details, 1);
  assert.equal(lists, 2);
});

test('playlist validation uses the proxy User-Agent and rejects HTML, errors and redirects', async t => {
  const server = http.createServer((req, res) => {
    assert.equal(req.headers['user-agent'], USER_AGENT);
    assert.equal(req.headers.referer, 'https://live.kankanews.com/');
    if (req.url === '/good') return res.end('#EXTM3U\n#EXTINF:4,\n1.ts\n');
    if (req.url === '/redirect') res.writeHead(302, { Location: '/good' });
    if (req.url === '/error') res.statusCode = 403;
    res.end('<html>not a playlist</html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await validateStream(`${base}/good`), true);
  for (const path of ['/html', '/error', '/redirect']) assert.equal(await validateStream(`${base}${path}`), false);
});
