/**
 * vps-capture.js - 使用 Playwright 捕获 kankanews m3u8 URL
 *
 * 原理:
 *   kankanews 的 m3u8 URL 由页面 JS 动态生成,带有 JWT token。
 *   JWT 中绑定了获取时的 IP (user_ip)。
 *   用真实浏览器打开页面,监听网络请求,截获 m3u8 URL。
 *
 * 依赖:
 *   npm install playwright
 *   npx playwright install chromium
 *
 * 用法:
 *   node vps-capture.js
 *   # 输出到 /tmp/kk-m3u8-cache.json
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ===== 配置 =====
const CACHE_FILE = process.env.CACHE_FILE || '/tmp/kk-m3u8-cache.json';
const CHANNEL_ID = process.env.CHANNEL_ID || '10';
const PAGE_URL = `https://live.kankanews.com/huikan?id=${CHANNEL_ID}`;

/**
 * 捕获 m3u8 URL
 *
 * 流程:
 * 1. 启动 headless Chromium
 * 2. 打开 kankanews 回看页面
 * 3. 监听所有网络请求,过滤 .m3u8 请求
 * 4. 从 JWT 中提取过期时间
 * 5. 保存到缓存文件
 */
async function capture() {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Starting capture for channel ${CHANNEL_ID}...`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/126.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  // 事件驱动: 等待 m3u8 响应出现,而非固定延迟
  const MAX_WAIT_MS = 30000; // 最长等待 30 秒
  const waitForM3u8 = () => new Promise((resolve) => {
    const check = setInterval(() => {
      if (m3u8Urls.length > 0) { clearInterval(check); resolve(true); }
    }, 200);
    setTimeout(() => { clearInterval(check); resolve(false); }, MAX_WAIT_MS);
  });

  // 收集 m3u8 URL
  // 过滤逻辑: 是 m3u8 且不是 kankanews 自身资源 (排除页面可能内嵌的清单)
  const m3u8Urls = [];
  const IGNORE_HOSTS = ['live.kankanews.com', 'skin.kankanews.com', 'm.kankanews.com'];
  page.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('.m3u8')) return;
    try {
      const host = new URL(url).hostname;
      if (IGNORE_HOSTS.some(h => host.includes(h))) return;
    } catch { return; }
    m3u8Urls.push(url);
    console.log(`  Found m3u8: ${url.substring(0, 100)}...`);
  });

  try {
    // 打开页面
    console.log(`  Opening ${PAGE_URL}`);
    await page.goto(PAGE_URL, { waitUntil: 'networkidle', timeout: 30000 });

    // 尝试点击播放按钮
    try {
      const playBtn = await page.$('.xgplayer-start, .xgplayer-play, [data-xgplayerid]');
      if (playBtn) {
        await playBtn.click();
      }
    } catch {
      // 播放按钮可能不存在或已自动播放
    }

    // 等待 m3u8 响应 (事件驱动,最长 30 秒)
    console.log('  Waiting for m3u8 response...');
    const found = await waitForM3u8();
    if (!found) {
      console.log('  WARNING: No m3u8 response within timeout!');
      await browser.close();
      return null;
    }

    // 取最新的 URL
    const latestUrl = m3u8Urls[m3u8Urls.length - 1];
    console.log(`  Latest m3u8: ${latestUrl.substring(0, 120)}...`);

    // 解析 JWT
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

    // 保存缓存
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

// 直接运行
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
