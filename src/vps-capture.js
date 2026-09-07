const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { signRequest } = require('./signing');
const { getCacheFile, getDefaultChannelId } = require('./cache-store');
const { USER_AGENT, COMMON_HEADERS } = require('./http-headers');
const { resolveStreamSource } = require('./stream-source');

async function validateStream(url) {
  const response = await fetch(url, {
    headers: COMMON_HEADERS,
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    return false;
  }
  return (await response.text()).trimStart().startsWith('#EXTM3U');
}

async function capture(options = {}) {
  const channelId = String(options.channelId || getDefaultChannelId());
  const cacheFile = options.cacheFile || getCacheFile(channelId);
  const log = message => console.log(`  [${channelId}] ${message}`);
  let browser;
  let temporaryFile;
  console.log(`[${new Date().toISOString()}] Starting capture for channel ${channelId}...`);
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'zh-CN' });
    const page = await context.newPage();
    await page.goto(`https://live.kankanews.com/huikan?id=${encodeURIComponent(channelId)}`, {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });

    // Keep API requests in the browser; stream tokens bind both the IP and User-Agent.
    const apiGet = (endpoint, params) => page.evaluate(async ({ endpoint, params, headers }) => {
      const response = await fetch(`https://kapi.kankanews.com${endpoint}?${new URLSearchParams(params)}`, {
        headers: { ...headers, Accept: 'application/json', 'M-Uuid': localStorage.getItem('uuid') || '' },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`API HTTP ${response.status}`);
      return response.json();
    }, { endpoint, params, headers: signRequest(params) });

    const stream = await resolveStreamSource({ channelId, apiGet, validateStream, log });
    if (!stream) {
      log('No playable source found; keeping the previous cache.');
      return null;
    }
    const cache = { ...stream, capturedAt: Math.floor(Date.now() / 1000), channelId };
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    temporaryFile = `${cacheFile}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify(cache, null, 2));
    await fs.rename(temporaryFile, cacheFile);
    log(`Saved ${stream.source} ${stream.sourceType} to ${cacheFile}`);
    log(`Expires: ${cache.exp ? new Date(cache.exp * 1000).toISOString() : 'unknown'}`);
    return cache;
  } catch (error) {
    log(`Capture failed: ${error.message}`);
    return null;
  } finally {
    if (temporaryFile) await fs.unlink(temporaryFile).catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

if (require.main === module) {
  capture().then(result => { if (!result) process.exitCode = 1; });
}

module.exports = { capture, validateStream };
