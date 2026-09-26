const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createBrowserApi } = require('../src/browser-api');
const { USER_AGENT, COMMON_HEADERS } = require('../src/http-headers');

const endpoint = '/content/pc/tv/channel/detail';
const params = { channel_id: '10' };
const headers = { platform: 'pc', timestamp: 1234567890, sign: 'test-signature' };
const result = { code: '1000', result: { id: 10 } };

function pageWith(evaluate) {
  return Object.assign(new EventEmitter(), { evaluate });
}

function responseWith(status, body, onDispose = () => {}) {
  return { status: () => status, text: async () => body, dispose: async () => onDispose() };
}

test('successful page requests retain signed parameters without invoking the fallback', async () => {
  const page = pageWith(async (_, args) => {
    assert.equal(new URL(args.url).searchParams.get('channel_id'), '10');
    assert.equal(args.headers.timestamp, String(headers.timestamp));
    assert.equal(args.headers.sign, headers.sign);
    return { status: 200, text: JSON.stringify(result) };
  });
  const apiGet = createBrowserApi({ page, requestContext: { get: async () => assert.fail('unexpected fallback') } });
  assert.deepEqual(await apiGet(endpoint, params, headers), result);
});

test('Failed to fetch falls back with the same signature, UUID, User-Agent and bounded request options', async () => {
  const logs = [];
  let disposed = false;
  const page = pageWith(async (_, args) => {
    if (!args) return 'browser-uuid';
    page.emit('requestfailed', { url: () => args.url, failure: () => ({ errorText: 'net::ERR_FAILED' }) });
    throw new Error('page.evaluate: TypeError: Failed to fetch\n    browser stack');
  });
  const apiGet = createBrowserApi({
    page, log: message => logs.push(message),
    requestContext: { get: async (url, options) => {
      assert.equal(url, require('../src/relay').toApiUrl('/content/pc/tv/channel/detail') + '?channel_id=10');
      assert.equal(options.headers.sign, headers.sign);
      assert.equal(options.headers.timestamp, String(headers.timestamp));
      assert.equal(options.headers['M-Uuid'], 'browser-uuid');
      assert.equal(options.headers['User-Agent'], USER_AGENT);
      assert.equal(options.headers.Referer, COMMON_HEADERS.Referer);
      assert.equal(options.headers.Origin, COMMON_HEADERS.Origin);
      assert.equal(options.maxRedirects, 0);
      assert.equal(options.timeout, 15000);
      return responseWith(200, JSON.stringify(result), () => { disposed = true; });
    } },
  });
  assert.deepEqual(await apiGet(endpoint, params, headers), result);
  assert.equal(disposed, true);
  assert.match(logs[0], /net::ERR_FAILED.*Failed to fetch.*direct HTTP/);
  assert.ok(!logs[0].includes('\n'));
});

test('non-JSON page responses use the fallback without logging response contents', async () => {
  const logs = [];
  const page = pageWith(async (_, args) => args ? { status: 200, text: '<html>private response contents</html>' } : 'uuid');
  const apiGet = createBrowserApi({
    page, log: message => logs.push(message),
    requestContext: { get: async () => responseWith(200, JSON.stringify(result)) },
  });
  assert.deepEqual(await apiGet(endpoint, params, headers), result);
  assert.match(logs[0], /non-JSON/);
  assert.ok(!logs.join('').includes('private response contents'));
});

test('valid API error responses are returned without a duplicate request', async () => {
  const rejected = { code: '4001', result: null };
  const apiGet = createBrowserApi({
    page: pageWith(async () => ({ status: 200, text: JSON.stringify(rejected) })),
    requestContext: { get: async () => assert.fail('API business errors should not trigger a transport retry') },
  });
  assert.deepEqual(await apiGet(endpoint, params, headers), rejected);
});

test('unavailable live pages do not prevent direct API requests', async () => {
  const apiGet = createBrowserApi({
    pageAvailable: false,
    page: pageWith(async () => assert.fail('unavailable pages must not be evaluated')),
    requestContext: { get: async (_, options) => {
      assert.equal(options.headers['M-Uuid'], '');
      return responseWith(200, JSON.stringify(result));
    } },
  });
  assert.deepEqual(await apiGet(endpoint, params, headers), result);
});

test('direct request failures expose network causes without copying request headers or call logs', async () => {
  const page = pageWith(async (_, args) => {
    if (!args) throw new Error('localStorage unavailable');
    throw new Error('page.evaluate: TypeError: Failed to fetch\nprivate browser details');
  });
  const apiGet = createBrowserApi({
    page,
    requestContext: { get: async () => {
      throw Object.assign(new Error('apiRequestContext.get: DNS lookup failed\nCall log:\nsecret request headers'), { code: 'ENOTFOUND' });
    } },
  });
  await assert.rejects(apiGet(endpoint, params, headers), error => {
    assert.match(error.message, /Failed to fetch.*DNS lookup failed.*ENOTFOUND/);
    assert.doesNotMatch(error.message, /private|secret|\n/);
    return true;
  });
});

test('redirects, HTTP errors and invalid JSON from the fallback fail cleanly and release response buffers', async () => {
  for (const [status, body, expected] of [
    [302, '', /HTTP 302/], [403, '', /HTTP 403/],
    [403, '<title>WAF拦截页面</title>', /HTTP 403 \(upstream WAF block\)/],
    [200, '<html>blocked</html>', /non-JSON/],
  ]) {
    let disposed = false;
    const apiGet = createBrowserApi({
      pageAvailable: false, page: pageWith(async () => ''),
      requestContext: { get: async () => responseWith(status, body, () => { disposed = true; }) },
    });
    await assert.rejects(apiGet(endpoint, params, headers), expected);
    assert.equal(disposed, true);
  }
});

test('signed requests cannot be redirected to another API origin through the endpoint argument', async () => {
  const apiGet = createBrowserApi({
    page: pageWith(async () => assert.fail('unexpected page request')),
    requestContext: { get: async () => assert.fail('unexpected direct request') },
  });
  await assert.rejects(apiGet('https://example.test/api', params, headers), /configured origin/);
});
