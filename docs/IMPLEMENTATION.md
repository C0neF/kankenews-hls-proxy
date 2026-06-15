# 技术实现详解

## 逆向工程过程

### 1. 页面分析

kankanews 回看页面 (`https://live.kankanews.com/huikan?id=10`) 使用 Nuxt.js SSR 渲染,视频播放器是 xgplayer。

页面结构:
```
/_knews_nuxt/js/app.v2.41.9.js          ← 主 bundle (含 axios 拦截器 + 签名)
/_knews_nuxt/js/commons/app.v2.41.9.js  ← 公共模块
/_knews_nuxt/js/vendors/app.v2.41.9.js  ← vendor (含 js-md5)
/_knews_nuxt/js/pages/huikan/index.v2.41.9.js  ← 回看页面逻辑
/_knews_nuxt/js/pages/huikan/index/pages/index.v2.41.9.js  ← 子页面
```

### 2. API 发现

通过分析 `huikan.js` 的 `asyncData` 和 `initPlayer` 函数,发现以下 API:

| API | 用途 |
|---|---|
| `GET /content/pc/tv/channels` | 频道列表 |
| `GET /content/pc/tv/slitProgram/list` | 节目列表 |
| `GET /content/pc/tv/program/detail?channel_program_id=X` | 节目详情 (含加密流地址) |
| `GET /content/pc/tv/channel/detail?channel_id=X` | 频道详情 (含加密流地址) |

所有 API 的 base URL: `https://kapi.kankanews.com`

### 3. 签名算法逆向

在 `app.v2.41.9.js` 的 module 227 中找到 axios 拦截器:

```javascript
// 简化后的原始代码
var h = function (version = "v1") {
  var instance = axios.create({
    baseURL: "https://kapi.kankanews.com",
    withCredentials: false,
    timeout: 8000,
  });
  
  instance.interceptors.request.use(function (config) {
    var params = config.method === "post" ? config.data : config.params;
    var headers = signFunction(params, version);  // ← 签名
    for (var key in headers) config.headers[key] = headers[key];
    config.headers["M-Uuid"] = localStorage.getItem("uuid");
    return config;
  });
  
  return instance;
};
```

`signFunction` 是 module 80 的 `se` 函数:

```javascript
// 简化后的签名函数
function sign(params, version = "v1") {
  var commonParams = {
    platform: "pc",
    version: "2.41.9",
    nonce: Math.random().toString(36).slice(-8),
    timestamp: Math.floor(Date.now() / 1000),
    "Api-Version": version,
  };
  
  // 合并参数
  var merged = Object.assign({}, params, commonParams);
  
  // 按 key 排序
  var sorted = {};
  Object.keys(merged).sort().forEach(k => { sorted[k] = merged[k]; });
  
  // 拼接
  var str = "";
  for (var k in sorted) {
    if (sorted[k] != null) str += k + "=" + sorted[k] + "&";
  }
  
  // 追加密钥 + 双重 MD5
  str += "28c8edde3d61a0411511d3b1866f0636";
  var signValue = md5(md5(str));
  
  return Object.assign({}, sorted, { sign: signValue });
}
```

### 4. 签名密钥提取

密钥 `28c8edde3d61a0411511d3b1866f0636` 硬编码在 `ce` 函数中:

```javascript
// module 80 中的 ce 函数
function ce(params) {
  params = sortKeys(params);
  var str = "";
  for (var key in params) str += key + "=" + params[key] + "&";
  str += "28c8edde3d61a0411511d3b1866f0636";  // ← 密钥
  params.sign = md5(md5(str));
  return params;
}
```

MD5 使用 `js-md5` 库 (module 324 in vendors/app.v2.41.9.js)。

### 5. RSA 解密算法逆向

API 返回的流地址经过 RSA 加密。解密函数在 `huikan2.js` 的 module 576 中:

```javascript
// 简化后的解密函数
var PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDP5hzPUW5RFeE2xBT1ERB3hHZI
Votn/qatWhgc1eZof09qKjElFN6Nma461ZAwGpX4aezKP8Adh4WJj4u2O54xCXDt
wzKRqZO2oNZkuNmF2Va8kLgiEQAAcxYc8JgTN+uQQNpsep4n/o1sArTJooZIF17E
tSqSgXDcJ7yDj5rc7wIDAQAB
-----END PUBLIC KEY-----`;

function decodeUrl(encodedStr) {
  // 1. Base64 → 二进制
  var binary = atob(encodedStr);
  
  // 2. 二进制 → 十六进制字符串
  var hex = binaryToHex(binary).toUpperCase();
  
  // 3. 按 256 字符分块 (128 字节 = 1024-bit RSA)
  var result = "";
  for (var i = 0; i < hex.length; i += 256) {
    var chunk = hex.slice(i, i + 256);
    
    // 4. 十六进制 → 二进制 → Base64
    var base64Chunk = btoa(hexToBinary(chunk));
    
    // 5. RSA 公钥解密 (JSEncrypt)
    var decrypted = jsEncrypt.decrypt(base64Chunk);
    if (decrypted) result += decrypted;
  }
  
  return result;
}
```

**关键发现**:这里使用 `JSEncrypt.setPublicKey()` + `decrypt()`,实际上是用公钥做原始 RSA 运算 (`c^e mod n`),而非标准的 RSA 解密。

### 6. 为什么纯 Node.js 请求被拒

API 服务器 (TencentEdgeOne CDN) 会检测 TLS 指纹。Node.js 的 `https` 模块的 TLS 指纹与浏览器不同,因此:
- 浏览器请求: ✅ 通过
- curl 请求: ✅ 通过 (使用系统 TLS)
- Node.js 请求: ❌ 被拒 (返回 4001)

这就是为什么需要 Playwright (真实浏览器) 来调用 API。

### 7. IP 绑定机制

m3u8 URL 中的 JWT 包含 `user_ip` 字段:

```json
{
  "app": "live",
  "domain": "volc-stream.kksmg.com",
  "exp": 1781563695,
  "stream_name": "wxty",
  "user_ip": "167.99.79.203",
  ...
}
```

CDN (ByteDance NSS) 会校验请求 IP 是否与 JWT 中的 `user_ip` 一致。不一致则返回 403。

这就是为什么:
- 纯 Worker 方案不行 (Worker 的出口 IP ≠ 用户 IP)
- VPS 方案可行 (Playwright 和代理在同一台 VPS)
- OpenWrt 方案可行 (路由器和用户在同一网络,出口 IP 相同)

## 数据流

```
┌─ VPS 上的 Playwright ──────────────────────────────────────┐
│                                                              │
│  1. 打开 https://live.kankanews.com/huikan?id=10            │
│  2. 浏览器 JS 自动完成:                                      │
│     a. 调 kapi API (带双 MD5 签名)                           │
│     b. API 返回 RSA 加密的流地址                             │
│     c. 浏览器 JS 用硬编码公钥解密                            │
│     d. 得到 m3u8 URL (带 JWT token)                          │
│  3. Playwright 监听网络请求,截获 m3u8 URL                    │
│  4. 保存到缓存文件                                           │
│                                                              │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─ 代理服务器 (VPS / OpenWrt) ────────────────────────────────┐
│                                                              │
│  1. 读取缓存的 m3u8 URL                                      │
│  2. 请求 CDN 获取 m3u8 清单                                  │
│     (带 Referer: https://live.kankanews.com/)                │
│  3. 改写清单中的分片 URL → 走代理                            │
│  4. 返回改写后的清单给 PotPlayer                             │
│  5. PotPlayer 请求分片时,代理转发到 CDN                      │
│     (同一出口 IP, CDN 校验通过)                              │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```
