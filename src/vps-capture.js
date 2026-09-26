const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { signRequest } = require('./signing');
const { getCacheFile, getDefaultChannelId, readCache } = require('./cache-store');
const { USER_AGENT, COMMON_HEADERS } = require('./http-headers');
const { resolveStreamSource } = require('./stream-source');
const { createApiQueue } = require('./api-queue');
const { createBrowserApi, describeError } = require('./browser-api');
const { browserProxy, requestBuffer } = require('./upstream-request');
const { toUpstreamMediaUrl } = require('./relay');

const scheduleApi = createApiQueue();

async function validateStream(url) {
  const response = await requestBuffer(toUpstreamMediaUrl(url), COMMON_HEADERS, 10000);
  return response.status === 200 && response.body.toString().trimStart().startsWith('#EXTM3U');
}

async function capture(options = {}) {
  const channelId = String(options.channelId || getDefaultChannelId());
  const cacheFile = options.cacheFile || getCacheFile(channelId);
  const log = message => console.log(`  [${channelId}] ${message}`);
  const previousCache = options.previousCache ?? await readCache(channelId, { dataDir: path.dirname(cacheFile) });
  let browser;
  let temporaryFile;
  console.log(`[${new Date().toISOString()}] Starting capture for channel ${channelId}...`);
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'zh-CN', proxy: browserProxy });
    const page = await context.newPage();
    let pageAvailable = true;
    try {
      const response = await page.goto(`https://live.kankanews.com/huikan?id=${encodeURIComponent(channelId)}`, {
        waitUntil: 'domcontentloaded', timeout: 30000,
      });
      if (!response?.ok()) throw new Error(`Live page HTTP ${response?.status() ?? 'unknown'}`);
    } catch (error) {
      pageAvailable = false;
      log(`Live page unavailable (${describeError(error)}); using direct API requests.`);
    }

    const requestApi = createBrowserApi({ page, requestContext: context.request, pageAvailable, log });
    const apiGet = (endpoint, params) => scheduleApi(() => requestApi(endpoint, params, signRequest(params)));

    const stream = await resolveStreamSource({
      channelId, apiGet, validateStream, log, previousCache, sourceState: options.sourceState,
    });
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
