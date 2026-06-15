/**
 * vps-capture.js - 使用 Playwright 捕获 kankanews m3u8 URL
 *
 * 策略:
 *   不依赖播放器初始化。直接截获 kapi API 返回的 program/detail 响应,
 *   从中提取加密的流地址,用 Node.js 解码得到 m3u8 URL。
 *   这样 headless 浏览器不播放视频也能拿到 URL。
 */

const { chromium } = require('playwright');
const fs = require('fs');
const crypto = require('crypto');

// ===== 配置 =====
const CACHE_FILE = process.env.CACHE_FILE || '/tmp/kk-m3u8-cache.json';
const CHANNEL_ID = process.env.CHANNEL_ID || '10';
const PAGE_URL = `https://live.kankanews.com/huikan?id=${CHANNEL_ID}`;

// ===== RSA 常量 (与 signing.js 一致) =====
const RSA_N = BigInt(
  '0xcfe61ccf516e5115e136c414f5111077847648568b67fea6ad5a181cd5e6687f' +
  '4f6a2a312514de8d99ae3ad590301a95f869ecca3fc01d8785898f8bb63b9e31' +
  '0970edc33291a993b6a0d664b8d985d956bc90b82211000073161cf0981337eb' +
  '9040da6c7a9e27fe8d6c02b4c9a28648175ec4b52a928170dc27bc838f9adcef'
);
const RSA_E = BigInt(0x10001);
const RSA_BLOCK_SIZE = 128;

function modPow(base, exp, mod) {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp % 2n === 1n) result = (result * base) % mod;
    exp = exp / 2n;
    base = (base * base) % mod;
  }
  return result;
}

function rsaDecryptHex(chunkHex) {
  const m = modPow(BigInt('0x' + chunkHex), RSA_E, RSA_N);
  return m.toString(16).padStart(RSA_BLOCK_SIZE * 2, '0');
}

function decodeUrl(encodedStr) {
  if (!encodedStr || typeof encodedStr !== 'string') return '';
  const hex = Buffer.from(encodedStr, 'base64').toString('hex').toUpperCase();
  let result = '';
  for (let i = 0; i < hex.length; i += RSA_BLOCK_SIZE * 2) {
    const chunkHex = hex.slice(i, i + RSA_BLOCK_SIZE * 2);
    if (chunkHex.length < RSA_BLOCK_SIZE * 2) continue;
    try {
      const decHex = rsaDecryptHex(chunkHex);
      if (decHex.startsWith('0001')) {
        let separatorPos = -1;
        for (let k = 4; k < decHex.length; k += 2) {
          if (decHex.slice(k, k + 2) === '00') { separatorPos = k; break; }
        }
        if (separatorPos >= 12 && /^FF+$/.test(decHex.slice(4, separatorPos))) {
          const dataHex = decHex.slice(separatorPos + 2);
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
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'zh-CN',
  });

  const page = await context.newPage();

  // 直接截获 kapi 的 program/detail 响应
  let programDetail = null;
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('/content/pc/tv/program/detail')) {
      try {
        const json = await response.json();
        if (json.code === 1000 && json.result) {
          programDetail = json.result;
          console.log(`  ✓ Program detail captured: ${json.result.name}`);
        }
      } catch {}
    }
  });

  try {
    // 打开页面 (等 DOM 就绪即可,不需要等播放器)
    console.log(`  Opening ${PAGE_URL}`);
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 等待 program/detail API 被调用
    console.log('  Waiting for program/detail API...');
    for (let i = 0; i < 30; i++) {
      if (programDetail) break;
      await page.waitForTimeout(1000);
    }

    if (!programDetail) {
      console.log('  WARNING: program/detail API not captured!');
      await browser.close();
      return null;
    }

    await browser.close();

    // 从 programDetail 提取流地址并解码
    const ci = programDetail.channel_info;
    if (!ci) {
      console.log('  WARNING: No channel_info in program detail');
      return null;
    }

    const encoded = ci.shift_address || ci.live_address || '';
    if (!encoded) {
      console.log('  WARNING: No shift_address/live_address in channel_info');
      return null;
    }

    console.log(`  Encoded stream URL length: ${encoded.length}`);
    const m3u8Url = decodeUrl(encoded);

    if (!m3u8Url || !m3u8Url.startsWith('http')) {
      console.log('  WARNING: RSA decode failed or result is not a valid URL');
      return null;
    }

    console.log(`  Decoded m3u8: ${m3u8Url.substring(0, 120)}...`);

    // 解析 JWT
    let exp = null;
    let streamName = null;
    let userIp = null;
    try {
      const urlObj = new URL(m3u8Url);
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
      url: m3u8Url,
      exp,
      streamName,
      userIp,
      capturedAt: Math.floor(Date.now() / 1000),
      channelId: CHANNEL_ID,
    };

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
