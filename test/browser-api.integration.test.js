const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const test = require('node:test');
const { chromium } = require('playwright-core');
const { createBrowserApi } = require('../src/browser-api');
const { signRequest } = require('../src/signing');
const { USER_AGENT, COMMON_HEADERS } = require('../src/http-headers');
const { createUpstreamClient } = require('../src/upstream-request');

test('real Chromium recovers from a rejected CORS preflight using the context HTTP client', { timeout: 30000 }, async t => {
  const servers = [];
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await Promise.all(servers.map(server => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    })));
  });
  async function listen(handler) {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  const pageOrigin = await listen((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Capture transport test</title>');
  });
  let preflights = 0;
  const requests = [];
  const expected = { code: '1000', result: { id: 10 } };
  const apiOrigin = await listen((req, res) => {
    if (req.method === 'OPTIONS') {
      preflights++;
      // Deliberately omit CORS headers to reproduce the browser's Failed to fetch.
      res.writeHead(204);
      return res.end();
    }
    requests.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(expected));
  });
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const context = await browser.newContext({ userAgent: USER_AGENT });
  await context.addCookies([{ name: 'transport_test', value: 'browser-cookie', url: pageOrigin }]);
  const page = await context.newPage();
  await page.goto(pageOrigin);
  await page.evaluate(() => localStorage.setItem('uuid', 'browser-uuid'));
  const logs = [];
  const apiGet = createBrowserApi({ page, requestContext: context.request, baseUrl: apiOrigin, log: message => logs.push(message) });
  const params = { channel_id: '10' };
  const signed = signRequest(params);
  const result = await apiGet('/content/pc/tv/channel/detail', params, signed);

  assert.deepEqual(result, expected);
  assert.equal(preflights, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/content/pc/tv/channel/detail?channel_id=10');
  assert.equal(requests[0].headers['user-agent'], USER_AGENT);
  assert.equal(requests[0].headers.referer, COMMON_HEADERS.Referer);
  assert.equal(requests[0].headers.origin, COMMON_HEADERS.Origin);
  assert.equal(requests[0].headers['m-uuid'], 'browser-uuid');
  assert.equal(requests[0].headers.sign, signed.sign);
  assert.match(requests[0].headers.cookie, /transport_test=browser-cookie/);
  assert.match(logs.join('\n'), /Failed to fetch.*direct HTTP/);
});

test('browser requests, API fallback and HLS downloads share a configured proxy', { timeout: 30000 }, async t => {
  const requests = [];
  const handle = (req, res) => {
    const target = new URL(req.url, `http://${req.headers.host}`);
    requests.push({ host: target.hostname, method: req.method, userAgent: req.headers['user-agent'] });
    if (target.hostname === 'page.example.test') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<!doctype html><title>Proxy capture test</title>');
    }
    if (target.hostname === 'api.example.test') {
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: '1000', result: { url: 'http://cdn.example.test/index.m3u8' } }));
    }
    if (target.hostname === 'cdn.example.test') return res.end('#EXTM3U\n#EXTINF:4,\nsegment.ts\n');
    res.writeHead(404);
    res.end();
  };
  const backend = http.createServer(handle);
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const server = http.createServer(handle);
  const tunnels = new Set();
  server.on('connect', (req, socket, head) => {
    if (req.url !== 'api.example.test:80') return socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    tunnels.add(socket);
    const upstream = net.connect(backend.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    upstream.on('close', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => { tunnels.delete(socket); upstream.destroy(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = createUpstreamClient(`http://127.0.0.1:${server.address().port}`);
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await client.close();
    for (const socket of tunnels) socket.destroy();
    await Promise.all([server, backend].map(item => new Promise(resolve => { item.close(resolve); item.closeAllConnections(); })));
  });
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const context = await browser.newContext({ userAgent: USER_AGENT, proxy: client.browserProxy });
  const page = await context.newPage();
  await page.goto('http://page.example.test');
  const apiGet = createBrowserApi({ page, requestContext: context.request, baseUrl: 'http://api.example.test' });
  const params = { channel_id: '10' };
  const response = await apiGet('/content/pc/tv/channel/detail', params, signRequest(params));
  const playlist = await client.requestBuffer(response.result.url, COMMON_HEADERS);
  assert.match(playlist.body.toString(), /^#EXTM3U/);
  assert.ok(requests.some(item => item.host === 'page.example.test' && item.method === 'GET'));
  assert.ok(requests.some(item => item.host === 'api.example.test' && item.method === 'OPTIONS'));
  assert.ok(requests.some(item => item.host === 'api.example.test' && item.method === 'GET'));
  assert.ok(requests.some(item => item.host === 'cdn.example.test' && item.method === 'GET'));
  assert.ok(requests.filter(item => ['api.example.test', 'cdn.example.test'].includes(item.host) && item.method === 'GET')
    .every(item => item.userAgent === USER_AGENT));
});
