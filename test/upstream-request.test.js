const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { createUpstreamClient } = require('../src/upstream-request');
const { COMMON_HEADERS, USER_AGENT } = require('../src/http-headers');

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

test('browser proxy settings preserve HTTP credentials and normalize SOCKS URLs', () => {
  assert.equal(createUpstreamClient('').browserProxy, undefined);
  assert.deepEqual(createUpstreamClient('http://user:pass%40word@localhost:8080').browserProxy, {
    server: 'http://localhost:8080', username: 'user', password: 'pass@word',
  });
  assert.deepEqual(createUpstreamClient('socks5h://localhost:1080').browserProxy, { server: 'socks5://localhost:1080' });
  assert.deepEqual(createUpstreamClient('socks5://localhost').browserProxy, { server: 'socks5://localhost:1080' });
  for (const value of ['not a URL', 'file:///tmp/proxy', 'http://proxy/path', 'http://proxy/?token=private', 'socks5://user:password@proxy']) {
    assert.throws(() => createUpstreamClient(value), /UPSTREAM_PROXY|SOCKS/);
  }
});

test('unconfigured upstream requests connect directly and preserve partial responses', async t => {
  const { origin } = await serve(t, (req, res) => {
    assert.equal(req.url, '/segment.ts');
    assert.equal(req.headers.range, 'bytes=0-2');
    res.writeHead(206, { 'Content-Range': 'bytes 0-2/188', 'Content-Type': 'video/mp2t' });
    res.end(Buffer.from([0x47, 0, 0]));
  });
  const client = createUpstreamClient('');
  const response = await client.requestBuffer(`${origin}/segment.ts`, { ...COMMON_HEADERS, Range: 'bytes=0-2' });
  assert.equal(response.status, 206);
  assert.equal(response.headers['content-range'], 'bytes 0-2/188');
  assert.deepEqual(response.body, Buffer.from([0x47, 0, 0]));
});

test('playlist and streamed segment requests both use the configured HTTP proxy', async t => {
  const requests = [];
  const { origin } = await serve(t, (req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    if (req.url.endsWith('index.m3u8')) return res.end('#EXTM3U\n#EXTINF:4,\nsegment.ts\n');
    res.writeHead(206, { 'Content-Range': 'bytes 0-2/188' });
    res.end(Buffer.from([0x47, 0, 0]));
  });
  const client = createUpstreamClient(origin);
  t.after(() => client.close());
  const playlist = await client.requestBuffer('http://cdn.example.test/index.m3u8', COMMON_HEADERS);
  assert.match(playlist.body.toString(), /^#EXTM3U/);
  const segment = await client.requestStream('http://cdn.example.test/segment.ts', { ...COMMON_HEADERS, Range: 'bytes=0-2' });
  const chunks = [];
  for await (const chunk of segment) chunks.push(chunk);
  assert.equal(segment.statusCode, 206);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([0x47, 0, 0]));
  assert.deepEqual(requests.map(item => item.url), ['http://cdn.example.test/index.m3u8', 'http://cdn.example.test/segment.ts']);
  assert.ok(requests.every(item => item.headers['user-agent'] === USER_AGENT));
  assert.equal(requests[1].headers.range, 'bytes=0-2');
});

test('HTTPS upstream requests establish a CONNECT tunnel instead of bypassing the proxy', async t => {
  const { server, origin } = await serve(t, (_, res) => { res.statusCode = 500; res.end(); });
  const destinations = [];
  server.on('connect', (req, socket) => {
    destinations.push(req.url);
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  const client = createUpstreamClient(origin);
  t.after(() => client.close());
  const response = await client.requestBuffer('https://cdn.example.test/index.m3u8', COMMON_HEADERS);
  assert.equal(response.status, 403);
  assert.deepEqual(destinations, ['cdn.example.test:443']);
});

test('upstream request deadlines abort a server that never sends a response', async t => {
  const { origin } = await serve(t, () => {});
  const client = createUpstreamClient('');
  await assert.rejects(client.requestBuffer(origin, COMMON_HEADERS, 50), { code: 'ABORT_ERR' });
});
