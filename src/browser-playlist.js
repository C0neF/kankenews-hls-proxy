const { chromium } = require('playwright-core');
const { toUpstreamMediaUrl } = require('./relay');

let browser;
let page;
let opening;

function resolveCdpUrl() {
  return (process.env.BROWSER_CDP_URL || process.env.OBSCURA_CDP_URL || 'ws://127.0.0.1:9222').trim();
}

async function getPage() {
  if (page) return page;
  if (opening) return opening;
  opening = (async () => {
    browser = await chromium.connectOverCDP(resolveCdpUrl());
    const context = browser.contexts()[0] || await browser.newContext();
    page = await context.newPage();
    try {
      await page.goto('https://live.kankanews.com/huikan', { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (e) {}
    return page;
  })().finally(() => { opening = null; });
  return opening;
}

// Returns { body } when a target returns a playlist, { blocked } when a target
// explicitly answered a non-200 status, or null on pure transport failures (CORS, network).
async function fetchPlaylistBody(rawUrl, log = () => {}) {
  const targets = [toUpstreamMediaUrl(rawUrl), rawUrl];
  let blocked = 0;
  for (const target of targets) {
    try {
      const p = await getPage();
      const result = await p.evaluate(async (u) => {
        try {
          const res = await fetch(u, { redirect: 'manual' });
          const text = await res.text();
          return { status: res.status, text };
        } catch (e) {
          return { status: 0, text: String(e && e.message || e) };
        }
      }, target);
      if (result.status === 200 && String(result.text || '').trimStart().startsWith('#EXTM3U')) {
        return { body: result.text };
      }
      if (result.status > 0) blocked = result.status;
      log('browser playlist fetch ' + result.status);
    } catch (e) {
      log('browser playlist error ' + (e && e.message || e));
    }
  }
  return blocked ? { blocked } : null;
}

module.exports = { fetchPlaylistBody, getPage };
