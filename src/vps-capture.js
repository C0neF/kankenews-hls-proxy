const { chromium } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { signRequest } = require('./signing');
const { getCacheFile, getDefaultChannelId, readCache } = require('./cache-store');
const { USER_AGENT, COMMON_HEADERS } = require('./http-headers');
const { resolveStreamSource } = require('./stream-source');
const { createApiQueue } = require('./api-queue');
const { createBrowserApi, describeError } = require('./browser-api');
const { requestBuffer } = require('./upstream-request');
const { toUpstreamMediaUrl } = require('./relay');

const scheduleApi = createApiQueue();

function resolveCdpUrl() {
  const explicit = process.env.BROWSER_CDP_URL || process.env.OBSCURA_CDP_URL;
  if (explicit) return explicit.trim();
  return 'ws://127.0.0.1:9222';
}

function cdpCandidates(raw) {
  const base = String(raw || '').trim();
  if (!base) return ['ws://127.0.0.1:9222'];
  if (/^wss?:\/\//i.test(base)) return [...new Set([base, base.replace(/^ws/i, 'http')])];
  if (/^https?:\/\//i.test(base)) return [...new Set([base, base.replace(/^http/i, 'ws')])];
  return [`ws://${base}`, `http://${base}`];
}

async function openBrowser(log) {
  const raw = resolveCdpUrl();
  let lastError = null;
  for (const cdpUrl of cdpCandidates(raw)) {
    log(`Connecting Obscura/CDP at ${cdpUrl}`);
    try {
      const browser = await chromium.connectOverCDP(cdpUrl);
      return { browser, external: true };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Obscura CDP connect failed (${describeError(lastError)}). ` +
    `Start Obscura: obscura serve --port 9222 --stealth. ` +
    `Default CDP ws://127.0.0.1:9222; override with BROWSER_CDP_URL.`
  );
}

async function openContext(browser) {
  const options = { userAgent: USER_AGENT, locale: 'zh-CN' };
  const existing = browser.contexts()[0];
  if (existing) return existing;
  return browser.newContext(options);
}

function isM3u8Body(buf) {
  return buf.toString('utf8').trimStart().startsWith('#EXTM3U');
}

async function probePlaylist(url) {
  try {
    const response = await requestBuffer(url, COMMON_HEADERS, 10000);
    const body = response.body;
    return {
      ok: response.status === 200 && isM3u8Body(body),
      status: response.status,
      preview: body.toString('utf8').slice(0, 80).replace(/\s+/g, ' '),
    };
  } catch (error) {
    return { ok: false, status: 0, preview: String(error && error.message || error) };
  }
}

function makeValidateStream(page, acceptOnFail) {
  return async function validateStream(url, log = () => {}) {

    const viaRelay = toUpstreamMediaUrl(url);
    const targets = [viaRelay, url];
    let last = { status: 0, preview: "" };
    for (const target of targets) {
      if (!page) {
        const r = await probePlaylist(target);
        if (r.ok) return true;
        last = r;
        continue;
      }
      try {
        const result = await page.evaluate(async (u) => {
          try {
            const res = await fetch(u, { redirect: "manual" });
            const text = await res.text();
            return { status: res.status, text: text.slice(0, 200000) };
          } catch (e) {
            return { status: 0, text: String(e && e.message || e) };
          }
        }, target);
        const ok = result.status === 200 && String(result.text || "").trimStart().startsWith("#EXTM3U");
        if (ok) {
          log("playlist ok via page.fetch " + new URL(target).host);
          return true;
        }
        last = { status: result.status, preview: String(result.text || "").slice(0, 60).replace(/\s+/g, " ") };
      } catch (e) {
        last = { status: 0, preview: String(e && e.message || e) };
      }
    }
    if (acceptOnFail) {
      log("playlist check failed " + last.status + " but accept (STRICT_PLAYLIST_CHECK!=1)");
      return true;
    }
    log("playlist check failed " + last.status + " " + last.preview);
    return false;
  };
}

async function validateStream(url, log = () => {}) {
  return makeValidateStream(null, false)(url, log);
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
    const opened = await openBrowser(log);
    browser = opened.browser;
    const context = await openContext(browser);
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
      channelId, apiGet, validateStream: makeValidateStream(page, process.env.STRICT_PLAYLIST_CHECK !== "1"), log, previousCache, sourceState: options.sourceState,
    });
    if (!stream) {
      log('No playable source found; keeping the previous cache.');
      return null;
    }
    let playlistBody = null;
    try {
      playlistBody = await page.evaluate(async (u) => {
        const res = await fetch(u, { redirect: "manual" });
        const text = await res.text();
        return res.status === 200 ? text : null;
      }, stream.url);
    } catch (e) {}
    const cache = { ...stream, capturedAt: Math.floor(Date.now() / 1000), channelId, playlistBody };
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

module.exports = { capture, validateStream, resolveCdpUrl, openBrowser, cdpCandidates };
