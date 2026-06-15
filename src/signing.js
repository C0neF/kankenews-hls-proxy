/**
 * signing.js - kankanews API 签名 + RSA 解密模块
 *
 * 从 kankanews 网页 JS 逆向得到:
 * - 双 MD5 签名算法 (app.js module 227)
 * - RSA 公钥解密 (huikan2.js module 576)
 */

const { createHash } = require('node:crypto');

// ===== 常量 =====
const SIGN_SECRET = '28c8edde3d61a0411511d3b1866f0636';
const APP_VERSION = '2.41.9';

// RSA 公钥分量 (从 SPKI 格式提取)
// 原始 PEM:
// -----BEGIN PUBLIC KEY-----
// MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDP5hzPUW5RFeE2xBT1ERB3hHZI
// Votn/qatWhgc1eZof09qKjElFN6Nma461ZAwGpX4aezKP8Adh4WJj4u2O54xCXDt
// wzKRqZO2oNZkuNmF2Va8kLgiEQAAcxYc8JgTN+uQQNpsep4n/o1sArTJooZIF17E
// tSqSgXDcJ7yDj5rc7wIDAQAB
// -----END PUBLIC KEY-----
const RSA_N = BigInt(
  '0xcfe61ccf516e5115e136c414f5111077847648568b67fea6ad5a181cd5e6687f' +
  '4f6a2a312514de8d99ae3ad590301a95f869ecca3fc01d8785898f8bb63b9e31' +
  '0970edc33291a993b6a0d664b8d985d956bc90b82211000073161cf0981337eb' +
  '9040da6c7a9e27fe8d6c02b4c9a28648175ec4b52a928170dc27bc838f9adcef'
);
const RSA_E = BigInt(0x10001); // 65537
const RSA_BLOCK_SIZE = 128;    // 字节 (1024-bit RSA)

// ===== MD5 =====
function md5(str) {
  return createHash('md5').update(str, 'utf8').digest('hex');
}

function doubleMd5(str) {
  return md5(md5(str));
}

// ===== 签名 =====
/**
 * 生成 API 请求签名
 *
 * 算法 (逆向自 app.js se 函数):
 * 1. 合并 common params + 业务 params
 * 2. 按 key 字母排序
 * 3. 拼接 "key=value&"
 * 4. 追加密钥
 * 5. 双重 MD5
 *
 * @param {Object} apiParams - 业务参数 (如 {channel_id: "10"})
 * @returns {Object} 包含签名和所有参数的 headers 对象
 */
function signRequest(apiParams = {}) {
  const params = {
    platform: 'pc',
    version: APP_VERSION,
    nonce: Math.random().toString(36).slice(2, 10),
    timestamp: Math.floor(Date.now() / 1000),
    'Api-Version': 'v1',
    ...apiParams,
  };

  // 按 key 排序
  const sorted = {};
  Object.keys(params).sort().forEach(k => { sorted[k] = params[k]; });

  // 拼接
  let str = '';
  for (const k in sorted) {
    if (sorted[k] != null) str += k + '=' + sorted[k] + '&';
  }
  str += SIGN_SECRET;

  return { ...sorted, sign: doubleMd5(str) };
}

// ===== RSA 解密 =====
/**
 * 模幂运算: base^exp mod mod
 */
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

/**
 * RSA 解密单个块 (直接操作 hex 字符串,无 Buffer 中转)
 *
 * @param {string} chunkHex - 256 字符的十六进制字符串 (128 字节)
 * @returns {string} 解密后的 hex 字符串 (含 PKCS#1 填充)
 */
function rsaDecryptHex(chunkHex) {
  const m = modPow(BigInt('0x' + chunkHex), RSA_E, RSA_N);
  return m.toString(16).padStart(RSA_BLOCK_SIZE * 2, '0');
}

/**
 * 解码 API 返回的加密流地址
 *
 * 流程:
 * 1. Base64 → hex 字符串
 * 2. 按 256 字符分块
 * 3. 每块 hex → BigInt → modPow → hex (无 Buffer 中转)
 * 4. 从 hex 解析 PKCS#1 填充,提取数据
 *
 * @param {string} encodedStr - Base64 编码的加密地址
 * @returns {string} 解密后的 URL
 */
function decodeUrl(encodedStr) {
  if (!encodedStr || typeof encodedStr !== 'string') return '';

  // Base64 → hex 字符串 (用 Buffer 一次转换,不逐字节循环)
  const hex = Buffer.from(encodedStr, 'base64').toString('hex').toUpperCase();

  let result = '';
  for (let i = 0; i < hex.length; i += RSA_BLOCK_SIZE * 2) {
    const chunkHex = hex.slice(i, i + RSA_BLOCK_SIZE * 2);
    if (chunkHex.length < RSA_BLOCK_SIZE * 2) continue;

    try {
      // hex → BigInt → modPow → hex (无 Buffer 中转)
      const decHex = rsaDecryptHex(chunkHex);

      // PKCS#1 Type 1: 00 01 FF...FF 00 <data>
      // 严格校验: 确认填充格式正确再提取数据
      if (decHex.startsWith('0001')) {
        // 从第 4 位(hex)开始找 00 分隔符,必须在偶数位(字节边界)
        let separatorPos = -1;
        for (let k = 4; k < decHex.length; k += 2) {
          if (decHex.slice(k, k + 2) === '00') {
            separatorPos = k;
            break;
          }
        }
        // 校验: 分隔符必须存在,且前面的填充字节全是 FF (至少 8 字节)
        if (separatorPos >= 12) {
          const padding = decHex.slice(4, separatorPos);
          const allFF = /^ff+$/i.test(padding);
          if (allFF) {
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
      }
    } catch (e) {
      // 解密失败的块跳过
    }
  }
  return result;
}

// ===== JWT 解析 =====
/**
 * 解析 JWT token 的 payload
 * @param {string} token - JWT token 字符串
 * @returns {Object|null} 解析后的 payload
 */
function parseJwt(token) {
  try {
    const payload = token.split('.')[1];
    const decoded = Buffer.from(
      payload.replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    ).toString();
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

// ===== KAPI 调用 =====
const https = require('node:https');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const KAPI_BASE = 'https://kapi.kankanews.com';

/**
 * 调用 kankanews API
 *
 * 注意: 请求的 headers 必须包含签名参数,
 * 而且 API 有 TLS 指纹检测,Node.js 原生 https 可能被拒。
 * 此函数仅在 VPS 上使用 Playwright 调用 API 时作为参考。
 *
 * @param {string} path - API 路径
 * @param {Object} params - 业务参数
 * @returns {Promise<Object>} API 响应
 */
function kapiGet(path, params = {}) {
  const headers = signRequest(params);
  const url = new URL(KAPI_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  return new Promise((resolve, reject) => {
    https.get(
      url.href,
      { headers: { ...headers, 'User-Agent': UA } },
      res => {
        let data = '';
        res.on('data', d => (data += d));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve(data); }
        });
      }
    ).on('error', reject);
  });
}

module.exports = {
  signRequest,
  decodeUrl,
  parseJwt,
  kapiGet,
  md5,
  doubleMd5,
  SIGN_SECRET,
  APP_VERSION,
};
