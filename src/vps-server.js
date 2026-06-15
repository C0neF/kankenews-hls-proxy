/**
 * vps-server.js - kankanews HLS 代理 (VPS 版,流式传输)
 *
 * 性能优化:
 *   - 分片代理采用流式传输,不缓冲整个响应
 *   - 缓存读写使用异步 I/O (fs.promises)
 *   - 缓存命中时用 createReadStream 流式发送
 *   - 缓存清理仅每 20 次请求执行一次 (降低 I/O)
 *   - 使用唯一临时文件名避免并发写入冲突
 *   - 支持多频道 (?id=X)
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { getDataDir, getDefaultChannelId, readCache: readCacheFile } = require('./cache-store');
const {
  buildSegmentResponseHeaders,
  isAllowedSegmentUrl,
  shouldCacheSegment,
} = require('./segment-policy');

// ===== 配置 =====
const PORT = process.env.PORT || 3000;
const DATA_DIR = getDataDir();
const SEG_CACHE_DIR = process.env.SEG_CACHE_DIR || '/tmp/kk-seg-cache';
const MAX_CACHE_SIZE = parseInt(process.env.MAX_CACHE_SIZE) || 1024 * 1024 * 1024;
const MAX_CACHE_AGE = parseInt(process.env.MAX_CACHE_AGE) || 1800;
const DEFAULT_CHANNEL_ID = getDefaultChannelId();
const EXPOSE_RAW_URL = process.env.EXPOSE_RAW_URL === '1';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const COMMON_HEADERS = {
  Referer: 'https://live.kankanews.com/',
  Origin: 'https://live.kankanews.com',
  'User-Agent': UA,
};

// ===== 频道列表 =====
const CHANNELS = [
  { id: '1',  name: '东方卫视' },
  { id: '2',  name: '新闻综合' },
  { id: '4',  name: '都市频道' },
  { id: '5',  name: '第一财经' },
  { id: '9',  name: '哈哈炫动' },
  { id: '10', name: '五星体育' },
  { id: '11', name: '魔都眼' },
  { id: '12', name: '新纪实' },
];

// 启动时确保缓存目录存在
fs.mkdirSync(SEG_CACHE_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

// ===== 缓存清理 (带频率限制) =====
let cleanupCounter = 0;
const CLEANUP_INTERVAL = 20; // 每 20 次请求清理一次

async function cleanupCache() {
  // 频率限制: 不是每次请求都清理
  if (++cleanupCounter < CLEANUP_INTERVAL) return;
  cleanupCounter = 0;

  try {
    const files = [];
    const now = Date.now() / 1000;
    const entries = await fsp.readdir(SEG_CACHE_DIR);

    for (const name of entries) {
      const fp = path.join(SEG_CACHE_DIR, name);
      try {
        const stat = await fsp.stat(fp);
        if (!stat.isFile()) continue;
        if (now - stat.mtimeMs / 1000 > MAX_CACHE_AGE) {
          await fsp.unlink(fp);
          continue;
        }
        files.push({ mtime: stat.mtimeMs, size: stat.size, path: fp });
      } catch {}
    }

    files.sort((a, b) => a.mtime - b.mtime);

    let totalSize = files.reduce((sum, f) => sum + f.size, 0);
    while (totalSize > MAX_CACHE_SIZE && files.length > 0) {
      const oldest = files.shift();
      await fsp.unlink(oldest.path);
      totalSize -= oldest.size;
    }
  } catch {}
}

// ===== 多频道缓存读取 =====
async function readCache(channelId = DEFAULT_CHANNEL_ID) {
  return readCacheFile(channelId, { dataDir: DATA_DIR, defaultChannelId: DEFAULT_CHANNEL_ID });
}

// ===== 流式 HTTPS 请求 =====
function httpsStream(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get(
      { hostname: u.hostname, path: u.pathname + u.search, headers },
      (res) => resolve(res)
    );
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('timeout')); });
  });
}

function httpsBuffer(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get(
      { hostname: u.hostname, path: u.pathname + u.search, headers },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    ).on('error', reject);
  });
}

// ===== m3u8 代理 (清单很小,全缓冲) =====
async function handleM3u8(req, res, cache, origin) {
  const resp = await httpsBuffer(cache.url, COMMON_HEADERS);

  if (resp.status !== 200) {
    res.writeHead(resp.status, { 'Content-Type': 'text/plain' });
    return res.end(`upstream ${resp.status}`);
  }

  const body = resp.body.toString();
  const lines = body.split(/\r?\n/);
  const rewritten = lines.map((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    let abs;
    try { abs = new URL(t, cache.url).href; } catch { return line; }
    if (abs.startsWith(origin)) return line;
    return `${origin}/seg?u=${encodeURIComponent(abs)}`;
  });

  const result = rewritten.join('\n');
  res.writeHead(200, {
    'Content-Type': 'application/vnd.apple.mpegurl',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=5',
    'Content-Length': Buffer.byteLength(result),
  });
  res.end(result);
}

// ===== 分片代理 (流式 + 异步缓存 + 唯一临时文件) =====
async function handleSegment(req, res, targetUrl) {
  if (!isAllowedSegmentUrl(targetUrl)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('segment URL host is not allowed');
  }

  const hasRange = !!req.headers['range'];
  const cacheKey = crypto.createHash('md5').update(targetUrl).digest('hex');
  const cacheFile = path.join(SEG_CACHE_DIR, `${cacheKey}.ts`);

  // 尝试缓存命中
  if (!hasRange) {
    try {
      await fsp.access(cacheFile);
      const stat = await fsp.stat(cacheFile);
      res.writeHead(200, buildSegmentResponseHeaders({
        contentType: 'video/mp2t',
        acceptRanges: 'bytes',
        contentLength: stat.size,
        cacheControl: 'public, max-age=3600',
        xCache: 'HIT',
      }));
      const stream = fs.createReadStream(cacheFile);
      await pipeline(stream, res);
      return;
    } catch {
      // 缓存未命中
    }
  }

  // 从 CDN 流式获取
  const headers = { ...COMMON_HEADERS };
  if (hasRange) headers['Range'] = req.headers['range'];

  let upstream;
  try {
    upstream = await httpsStream(targetUrl, headers);
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    return res.end(`upstream error: ${e.message}`);
  }

  res.writeHead(upstream.statusCode, buildSegmentResponseHeaders({
    contentType: upstream.headers['content-type'],
    acceptRanges: upstream.headers['accept-ranges'],
    contentLength: upstream.headers['content-length'],
    contentRange: upstream.headers['content-range'],
  }));

  const contentLength = parseInt(upstream.headers['content-length'] || '0', 10);
  if (shouldCacheSegment({ hasRange, statusCode: upstream.statusCode, contentLength })) {
    // 需要缓存: 唯一临时文件名避免并发冲突,完成后原子 rename
    const tmpFile = `${cacheFile}.${crypto.randomUUID()}.tmp`;
    const cacheWriteStream = fs.createWriteStream(tmpFile);
    upstream.pipe(cacheWriteStream);
    upstream.pipe(res);

    upstream.on('end', async () => {
      try {
        await fsp.rename(tmpFile, cacheFile);
      } catch {
        // rename 失败说明另一个请求已写入,清理自己的临时文件
        try { await fsp.unlink(tmpFile); } catch {}
      }
      // 频率限制的缓存清理 (不阻塞响应)
      cleanupCache();
    });
    upstream.on('error', async () => {
      try { await fsp.unlink(tmpFile); } catch {}
    });
  } else {
    upstream.pipe(res);
  }
}

// ===== CORS =====
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  'Access-Control-Max-Age': '86400',
};

// ===== HTTP 服务器 =====
const server = http.createServer(async (req, res) => {
  // OPTIONS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  let url;
  try {
    url = new URL(req.url, `http://localhost:${PORT}`);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }

  const channelId = url.searchParams.get('id') || process.env.CHANNEL_ID || '10';

  try {
    // 状态
    if (url.pathname === '/status') {
      const cache = await readCache(channelId);
      const now = Math.floor(Date.now() / 1000);
      let segCount = 0, cacheSize = 0;
      try {
        for (const name of await fsp.readdir(SEG_CACHE_DIR)) {
          try {
            const stat = await fsp.stat(path.join(SEG_CACHE_DIR, name));
            if (stat.isFile()) { segCount++; cacheSize += stat.size; }
          } catch {}
        }
      } catch {}
      const result = JSON.stringify({
        channelId,
        hasUrl: !!cache?.url,
        exp: cache?.exp,
        secondsLeft: cache?.exp ? cache.exp - now : null,
        streamName: cache?.streamName,
        capturedAt: cache?.capturedAt ? new Date(cache.capturedAt * 1000).toISOString() : null,
        cachedSegments: segCount,
        cacheSizeMb: Math.round(cacheSize / 1024 / 1024 * 100) / 100,
        cacheLimitMb: Math.round(MAX_CACHE_SIZE / 1024 / 1024),
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(result) });
      return res.end(result);
    }

    // m3u8 URL (JSON)
    if (url.pathname === '/url') {
      const cache = await readCache(channelId);
      const result = JSON.stringify({
        channelId,
        hasUrl: !!cache?.url,
        m3u8: EXPOSE_RAW_URL ? cache?.url || null : null,
        exp: cache?.exp || null,
        streamName: cache?.streamName || null,
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(result) });
      return res.end(result);
    }

    // 分片代理 (流式)
    if (url.pathname === '/seg' && url.searchParams.has('u')) {
      return handleSegment(req, res, url.searchParams.get('u'));
    }

    // 频道列表 M3U (/wx.m3u 不带 ?id=)
    if (url.pathname === '/wx.m3u' && !url.searchParams.has('id')) {
      const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
      const origin = `${proto}://${req.headers.host}`;
      let playlist = '#EXTM3U\n';
      for (const ch of CHANNELS) {
        const cache = await readCache(ch.id);
        const avail = cache?.url ? '' : ' [未捕获]';
        playlist += `#EXTINF:-1 group-title="看看新闻",${ch.name}${avail}\n`;
        playlist += `${origin}/?id=${ch.id}\n`;
      }
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Content-Length': Buffer.byteLength(playlist),
      });
      return res.end(playlist);
    }

    // 单频道 m3u8 代理 (/?id=X 或 /wx.m3u?id=X)
    if ((url.pathname === '/' && url.searchParams.has('id')) || url.pathname === '/wx.m3u') {
      const cache = await readCache(channelId);
      if (!cache?.url) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        return res.end(`No m3u8 URL for channel ${channelId}. Run capture first.`);
      }

      const now = Math.floor(Date.now() / 1000);
      if (cache.exp && now > cache.exp - 60) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        return res.end('m3u8 URL expired. Waiting for next capture.');
      }

      const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
      const origin = `${proto}://${req.headers.host}`;
      return handleM3u8(req, res, cache, origin);
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    console.error('Error:', e.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
    }
    res.end('Internal error: ' + e.message);
  }
});

server.listen(PORT, () => {
  console.log(`kankanews HLS Proxy running on port ${PORT}`);
  readCache().then((cache) => {
    if (cache?.url) {
      console.log(`Cached m3u8 expires: ${cache.exp ? new Date(cache.exp * 1000).toISOString() : 'unknown'}`);
    } else {
      console.log('No cached m3u8 URL. Run vps-capture.js first.');
    }
  });
});
