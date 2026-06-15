/**
 * vps-capture.js - 使用 Playwright 捕获 kankanews m3u8 URL
 *
 * 策略:
 *   1. 打开 kankanews 页面 (获得正确的 IP/浏览器指纹)
 *   2. 在页面上下文中直接调用 kapi API (自动携带签名)
 *   3. 从 API 响应中提取加密流地址
 *   4. 在 Node.js 中 RSA 解码得到 m3u8 URL
 *
 *   不依赖播放器初始化,不需要拦截网络请求。
 */

const { chromium } = require('playwright');
const fs = require('fs');
const crypto = require('crypto');

// ===== 配置 =====
const CACHE_FILE = process.env.CACHE_FILE || '/tmp/kk-m3u8-cache.json';
const CHANNEL_ID = process.env.CHANNEL_ID || '10';
const PAGE_URL = `https://live.kankanews.com/huikan?id=${CHANNEL_ID}`;

// ===== RSA 常量 =====
const RSA_N = BigInt(
  '0xcfe61ccf516e5115e136c414f5111077847648568b67fea6ad5a181cd5e6687f' +
  '4f6a2a312514de8d99ae3ad590301a95f869ecca3fc01d8785898f8bb63b9e31' +
  '0970edc33291a993b6a0d664b8d985d956bc90b82211000073161cf0981337eb' +
  '9040da6c7a9e27fe8d6c02b4c9a28648175ec4b52a928170dc27bc838f9adcef'
);
const RSA_E = BigInt(0x10001);
const RSA_BLOCK_SIZE = 128;

function modPow(base, exp, mod) {
  let result = 1n; base = base % mod;
  while (exp > 0n) { if (exp % 2n === 1n) result = (result * base) % mod; exp = exp / 2n; base = (base * base) % mod; }
  return result;
}

function decodeUrl(encodedStr) {
  if (!encodedStr || typeof encodedStr !== 'string') return '';
  const hex = Buffer.from(encodedStr, 'base64').toString('hex').toUpperCase();
  let result = '';
  for (let i = 0; i < hex.length; i += RSA_BLOCK_SIZE * 2) {
    const chunkHex = hex.slice(i, i + RSA_BLOCK_SIZE * 2);
    if (chunkHex.length < RSA_BLOCK_SIZE * 2) continue;
    try {
      const m = modPow(BigInt('0x' + chunkHex), RSA_E, RSA_N);
      const decHex = m.toString(16).padStart(RSA_BLOCK_SIZE * 2, '0');
      if (decHex.startsWith('0001')) {
        let sep = -1;
        for (let k = 4; k < decHex.length; k += 2) {
          if (decHex.slice(k, k + 2) === '00') { sep = k; break; }
        }
        if (sep >= 12 && /^FF+$/.test(decHex.slice(4, sep))) {
          const dataHex = decHex.slice(sep + 2);
          let str = '';
          for (let j = 0; j < dataHex.length; j += 2) {
            const code = parseInt(dataHex.slice(j, j + 2), 16);
            if (code === 0) break;
            str += String.fromCharCode(code);
          }
          result += str;
        }
      }
    } catch {}
  }
  return result;
}

// ===== 主流程 =====
async function capture() {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Starting capture for channel ${CHANNEL_ID}...`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'zh-CN',
  });

  const page = await context.newPage();

  try {
    // 1. 打开页面 (让页面 JS 加载完成,拿到 kapi 签名模块)
    console.log('  Opening page...');
    await page.goto(PAGE_URL, { waitUntil: 'networkidle', timeout: 30000 });
    console.log('  Page loaded');

    // 2. 在页面上下文中直接调 kapi API
    //    页面的 JS 已经加载了 axios 实例(带签名),我们直接用它
    console.log('  Calling kapi API from page context...');

    const result = await page.evaluate(async (channelId) => {
      try {
        // 方式 1: 直接用页面的 axios 实例 (已带签名)
        if (window.$nuxt && window.$nuxt.$axios) {
          const resp = await window.$nuxt.$axios.get(
            '/content/pc/tv/channel/detail',
            { params: { channel_id: channelId } }
          );
          return { method: 'nuxt-axios', data: resp.data || resp };
        }
      } catch (e) {}

      try {
        // 方式 2: 直接 fetch kapi (页面 JS 会自动加签名头)
        const url = new URL('https://kapi.kankanews.com/content/pc/tv/channel/detail');
        url.searchParams.set('channel_id', channelId);

        // 用页面自带的签名函数
        if (window.signRequest) {
          const headers = window.signRequest({ channel_id: channelId });
          for (const [k, v] of Object.entries(headers)) {
            url.searchParams.set(k, v);
          }
        }

        const resp = await fetch(url.href);
        return { method: 'fetch', data: await resp.json() };
      } catch (e) {
        return { error: e.message };
      }
    }, CHANNEL_ID);

    if (result.error) {
      console.log('  API call failed:', result.error);
    } else {
      console.log(`  API response (${result.method}):`, JSON.stringify(result.data).substring(0, 200));
    }

    // 3. 如果页面调用失败,回退:从 Network 拦截已加载的 API 响应
    //    (用 page.evaluate 在页面里找已缓存的响应数据)
    let channelInfo = null;

    if (result.data && result.data.code === 1000 && result.data.result) {
      channelInfo = result.data.result;
      console.log(`  Got channel info: ${channelInfo.name || channelId}`);
    } else {
      // 回退: 从页面 DOM/script 中提取
      console.log('  Trying to extract from page state...');
      const pageData = await page.evaluate(() => {
        // Nuxt 页面可能在 __NUXT__ 或 Vuex store 里有数据
        try {
          if (window.__NUXT__ && window.__NUXT__.data) {
            return JSON.stringify(window.__NUXT__.data);
          }
        } catch {}
        return null;
      });

      if (pageData) {
        console.log('  Found __NUXT__ data, length:', pageData.length);
      }
    }

    await browser.close();

    // 4. 解码流地址
    if (channelInfo) {
      const encoded = channelInfo.shift_address || channelInfo.live_address || '';
      if (encoded) {
        console.log(`  Encoded stream URL length: ${encoded.length}`);
        const m3u8Url = decodeUrl(encoded);

        if (m3u8Url && m3u8Url.startsWith('http')) {
          console.log(`  Decoded m3u8: ${m3u8Url.substring(0, 120)}...`);

          let exp = null, streamName = null, userIp = null;
          try {
            const urlObj = new URL(m3u8Url);
            const token = urlObj.searchParams.get('token');
            if (token) {
              const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
              exp = payload.exp;
              streamName = payload.stream_name;
              userIp = payload.user_ip;
              console.log(`  JWT exp: ${new Date(exp * 1000).toISOString()}`);
              console.log(`  JWT stream: ${streamName}`);
              console.log(`  JWT user_ip: ${userIp}`);
            }
          } catch {}

          const cache = { url: m3u8Url, exp, streamName, userIp, capturedAt: Math.floor(Date.now() / 1000), channelId: CHANNEL_ID };
          fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
          console.log(`  Saved to ${CACHE_FILE}`);
          return cache;
        }
      }
      console.log('  WARNING: No encoded stream URL in channel info');
    }

    console.log('  WARNING: Could not get channel info');
    return null;
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
