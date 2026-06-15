/**
 * vps-capture.js - 使用 Playwright 捕获 kankanews m3u8 URL
 *
 * 原理:
 *   kankanews 的 m3u8 URL 由页面 JS 动态生成,带有 JWT token。
 *   JWT 中绑定了获取时的 IP (user_ip)。
 *   用真实浏览器打开页面,监听网络请求,截获 m3u8 URL。
 *
 * 用法:
 *   node vps-capture.js
 */

const { chromium } = require('playwright');
const fs = require('fs');

// ===== 配置 =====
const CACHE_FILE = process.env.CACHE_FILE || '/tmp/kk-m3u8-cache.json';
const CHANNEL_ID = process.env.CHANNEL_ID || '10';
const PAGE_URL = `https://live.kankanews.com/huikan?id=${CHANNEL_ID}`;
const MAX_WAIT_MS = 30000;

async function capture() {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Starting capture for channel ${CHANNEL_ID}...`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/126.0.0.0 Safari/537.36',
    locale: 'zh-CN',
  });

  const page = await context.newPage();

  // 收集所有网络请求 (调试用)
  const allRequests = [];
  const m3u8Urls = [];
  const IGNORE_HOSTS = ['live.kankanews.com', 'skin.kankanews.com', 'm.kankanews.com'];

  page.on('response', (response) => {
    const url = response.url();
    allRequests.push(url);

    if (!url.includes('.m3u8')) return;
    try {
      const host = new URL(url).hostname;
      if (IGNORE_HOSTS.some(h => host.includes(h))) return;
    } catch { return; }
    m3u8Urls.push(url);
    console.log(`  ✓ m3u8 captured: ${url.substring(0, 120)}...`);
  });

  // 事件驱动等待
  const waitForM3u8 = () => new Promise((resolve) => {
    const check = setInterval(() => {
      if (m3u8Urls.length > 0) { clearInterval(check); resolve(true); }
    }, 200);
    setTimeout(() => { clearInterval(check); resolve(false); }, MAX_WAIT_MS);
  });

  try {
    // 1. 打开页面
    console.log(`  Opening ${PAGE_URL}`);
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('  Page loaded, waiting for JS...');
    await page.waitForTimeout(3000);

    // 2. 尝试多种方式触发播放
    console.log('  Trying to trigger playback...');

    // 方式 1: 点击 xgplayer 播放按钮
    try {
      const btns = await page.$$('.xgplayer-start, .xgplayer-play, .xgplayer-icon-play, [data-xgplayerid]');
      for (const btn of btns) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(500);
      }
    } catch {}

    // 方式 2: 点击 video 元素
    try {
      await page.click('video', { timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(1000);
    } catch {}

    // 方式 3: 通过 JS 强制播放
    try {
      await page.evaluate(() => {
        const videos = document.querySelectorAll('video');
        videos.forEach(v => { v.play().catch(() => {}); });
      });
    } catch {}

    // 3. 等待 m3u8 响应
    console.log('  Waiting for m3u8 response...');
    const found = await waitForM3u8();

    if (!found) {
      // 输出调试信息
      console.log('  WARNING: No m3u8 captured within timeout!');
      console.log(`  Total requests captured: ${allRequests.length}`);
      const videoReqs = allRequests.filter(u => u.includes('volc-stream') || u.includes('.m3u8') || u.includes('.ts'));
      if (videoReqs.length > 0) {
        console.log('  Video-related requests:');
        videoReqs.forEach(u => console.log(`    ${u.substring(0, 150)}`));
      } else {
        console.log('  No video requests found. Page may not have loaded player.');
        // 输出所有非资源请求 (排除 .js .css .png .jpg .svg .woff)
        const apiReqs = allRequests.filter(u =>
          !u.match(/\.(js|css|png|jpg|svg|woff|ico|gif|webp)(\?|$)/) &&
          !u.includes('sensors') && !u.includes('analytics')
        );
        console.log('  API/other requests:');
        apiReqs.slice(0, 20).forEach(u => console.log(`    ${u.substring(0, 150)}`));
      }
      await browser.close();
      return null;
    }

    // 4. 取最新的 URL
    const latestUrl = m3u8Urls[m3u8Urls.length - 1];
    console.log(`  Latest m3u8: ${latestUrl.substring(0, 120)}...`);

    // 5. 解析 JWT
    let exp = null;
    let streamName = null;
    let userIp = null;
    try {
      const urlObj = new URL(latestUrl);
      const token = urlObj.searchParams.get('token');
      if (token) {
        const payload = JSON.parse(
          Buffer.from(token.split('.')[1], 'base64').toString()
        );
        exp = payload.exp;
        streamName = payload.stream_name;
        userIp = payload.user_ip;
        console.log(`  JWT exp: ${new Date(exp * 1000).toISOString()}`);
        console.log(`  JWT stream: ${streamName}`);
        console.log(`  JWT user_ip: ${userIp}`);
      }
    } catch {
      console.log('  WARNING: Failed to parse JWT');
    }

    // 6. 保存缓存
    const cache = {
      url: latestUrl,
      exp,
      streamName,
      userIp,
      capturedAt: Math.floor(Date.now() / 1000),
      channelId: CHANNEL_ID,
    };

    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    console.log(`  Saved to ${CACHE_FILE}`);

    await browser.close();
    return cache;
  } catch (e) {
    console.error('  Error:', e.message);
    await browser.close();
    return null;
  }
}

if (require.main === module) {
  capture().then((result) => {
    if (result) {
      console.log(`\nDone! Expires: ${result.exp ? new Date(result.exp * 1000).toISOString() : 'unknown'}`);
    } else {
      console.log('\nFailed to capture m3u8 URL');
      process.exit(1);
    }
  });
}

module.exports = { capture };
