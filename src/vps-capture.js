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
        if (sep >= 12 && /^ff+$/i.test(decHex.slice(4, sep))) {
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
    // 1. 先注册 response 拦截 (在页面导航之前)
    //    用 waitForResponse 在页面自己消费响应之前拿到数据
    const channelDetailPromise = page.waitForResponse(
      (resp) => resp.url().includes('/content/pc/tv/channel/detail'),
      { timeout: 30000 }
    );

    // 2. 打开页面 (页面 JS 会自动调 kapi,带签名)
    console.log('  Opening page...');
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('  Page loaded, waiting for kapi response...');

    // 3. 拦截响应 (页面自己的 axios 发出的,带完整签名)
    const channelResp = await channelDetailPromise;
    const respData = await channelResp.json().catch(() => null);

    await browser.close();

    if (!respData || respData.code != 1000 || !respData.result) {
      console.log('  WARNING: channel/detail API failed:', JSON.stringify(respData).substring(0, 200));
      return null;
    }

    const channelInfo = respData.result;
    console.log(`  ✓ Channel info: ${channelInfo.name || channelId}`);

    // 调试: 输出 channel_info 的所有键
    const ci = channelInfo.channel_info;
    if (ci) {
      console.log(`  channel_info keys: ${Object.keys(ci).join(', ')}`);
      console.log(`  live_address length: ${(ci.live_address || '').length}`);
      console.log(`  shift_address length: ${(ci.shift_address || '').length}`);
    } else {
      console.log(`  result keys: ${Object.keys(channelInfo).join(', ')}`);
    }

    // 4. 解码流地址
    const encoded = (ci && (ci.shift_address || ci.live_address)) || channelInfo.shift_address || channelInfo.live_address || '';
    if (!encoded) {
      console.log('  WARNING: No encoded stream URL');
      return null;
    }

    console.log(`  Encoded stream URL length: ${encoded.length}`);
    console.log(`  Encoded first 40 chars: ${encoded.substring(0, 40)}`);
    const m3u8Url = decodeUrl(encoded);

    if (!m3u8Url || !m3u8Url.startsWith('http')) {
      console.log('  WARNING: RSA decode failed, result length:', m3u8Url.length);
      // 试用 channel_info 顶层字段
      if (channelInfo.live_address) {
        console.log('  Trying live_address directly...');
        const alt = decodeUrl(channelInfo.live_address);
        console.log('  live_address decode result length:', alt.length);
        if (alt.startsWith('http')) {
          console.log('  live_address worked:', alt.substring(0, 100));
        }
      }
      return null;
    }

    console.log(`  Decoded m3u8: ${m3u8Url.substring(0, 120)}...`);

    // 解析 JWT
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

    // 保存缓存
    const cache = { url: m3u8Url, exp, streamName, userIp, capturedAt: Math.floor(Date.now() / 1000), channelId: CHANNEL_ID };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    console.log(`  Saved to ${CACHE_FILE}`);
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
