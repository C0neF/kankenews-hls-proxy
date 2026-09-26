const http = require('node:http');
const https = require('node:https');

function parseProxy(value) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw new Error('UPSTREAM_PROXY must be a complete proxy URL'); }
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol) ||
      (url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('UPSTREAM_PROXY must use http, https or socks5 with no path, query or fragment');
  }
  const isSocks = url.protocol.startsWith('socks5');
  if (isSocks && (url.username || url.password)) {
    throw new Error('Chromium requires an unauthenticated SOCKS proxy; use HTTP for authenticated proxies');
  }
  const host = isSocks && !url.port ? `${url.hostname}:1080` : url.host;
  return {
    url: url.href,
    browser: {
      server: `${isSocks ? 'socks5:' : url.protocol}//${host}`,
      ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
      ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    },
  };
}

function createUpstreamClient(proxyValue = process.env.UPSTREAM_PROXY) {
  const proxy = parseProxy(proxyValue);
  let agentPromise;

  async function requestStream(rawUrl, headers, timeoutMs = 30000) {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported upstream protocol');
    let agent;
    if (proxy) {
      agentPromise ||= import('proxy-agent').then(({ ProxyAgent }) => new ProxyAgent({ getProxyForUrl: () => proxy.url }));
      agent = await agentPromise;
    }
    return new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).get(url, {
        headers, agent, signal: AbortSignal.timeout(timeoutMs),
      }, resolve);
      request.on('error', reject);
    });
  }

  async function requestBuffer(url, headers, timeoutMs) {
    const response = await requestStream(url, headers, timeoutMs);
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    return { status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) };
  }

  return {
    browserProxy: proxy?.browser,
    requestStream,
    requestBuffer,
    async close() { if (agentPromise) (await agentPromise).destroy(); },
  };
}

module.exports = { ...createUpstreamClient(), createUpstreamClient };
