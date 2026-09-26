# kankanews-hls-proxy

将看看新闻(五星体育)的 HLS 直播/回看流代理出来,供 PotPlayer、VLC、hls.js 等播放器使用。

## 快速开始

```bash
# 1. 拉取镜像
docker pull ghcr.io/c0nef/kankenews-hls-proxy:latest

# 2. 启动
docker compose up -d

# 3. PotPlayer 打开
# http://<你的设备IP>:53535/wx.m3u        → 全部频道列表
# http://<你的设备IP>:53535/?id=10       → 五星体育
# http://<你的设备IP>:53535/?id=1        → 东方卫视
```

## 支持频道

| ID | 频道 |
|---|---|
| 1 | 东方卫视 |
| 2 | 新闻综合 |
| 4 | 都市频道 |
| 5 | 第一财经 |
| 9 | 哈哈炫动 |
| 10 | 五星体育 |
| 11 | 魔都眼 |
| 12 | 新纪实 |

## URL 路由

| URL | 说明 |
|---|---|
| `/wx.m3u` | 全部频道 M3U 播放列表 |
| `/?id=10` | 单频道 m3u8 直播流 |
| `/status` | JSON 状态信息 |
| `/url` | JSON 返回当前缓存状态 (默认不暴露原始 m3u8 URL) |

## 部署场景

### 1. 服务器 / NAS / 电脑

```bash
git clone https://github.com/c0nef/kankenews-hls-proxy.git
cd kankenews-hls-proxy
docker compose up -d
```

PotPlayer: `http://<设备IP>:53535/wx.m3u` (频道列表)

### 2. OpenWrt 路由器 (需安装 Docker)

```bash
opkg update && opkg install dockerd docker
service dockerd start && service dockerd enable

docker pull ghcr.io/c0nef/kankenews-hls-proxy:latest
docker run -d \
  --name kk-hls-proxy \
  --restart unless-stopped \
  -p 53535:53535 \
  -e CHANNEL_ID=10 \
  -e CHANNEL_IDS=1,2,4,5,9,10,11,12 \
  -e MAX_CACHE_SIZE=268435456 \
  --security-opt seccomp=unconfined \
  ghcr.io/c0nef/kankenews-hls-proxy:latest
```

PotPlayer: `http://192.168.1.1:53535/wx.m3u` (频道列表)

### 3. 群晖 NAS

1. **Container Manager** → **映像** → 拉取 `ghcr.io/c0nef/kankenews-hls-proxy:latest`
2. **容器** → 新建:
   - 端口: `53535` → `53535`
   - 环境变量: `CHANNEL_ID=10`
   - 环境变量: `CHANNEL_IDS=1,2,4,5,9,10,11,12`
   - 高级设置: `--security-opt seccomp=unconfined`
3. 启动

PotPlayer: `http://<NAS IP>:53535/wx.m3u` (频道列表)

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `CHANNEL_ID` | `10` | 默认频道 ID |
| `CHANNEL_IDS` | `1,2,4,5,9,10,11,12` | 捕获频道列表,逗号分隔；只抓单频道时设为 `10` |
| `PORT` | `53535` | 容器内端口 |
| `CAPTURE_INTERVAL` | `36000000` | 最长刷新间隔 (毫秒, 默认 10 小时)；另按地址寿命提前 15–120 秒刷新，无到期时间的地址最多保留 20 分钟 |
| `ALLOWED_SEGMENT_HOSTS` | `volc-stream.kksmg.com,ws-channels.kksmg.com,tencent-stream.kksmg.com` | 允许代理的分片域名,逗号分隔 |
| `MAX_CACHE_SIZE` | `1073741824` | 最大分片缓存 (字节, 默认 1GB) |
| `MAX_CACHE_AGE` | `1800` | 缓存过期时间 (秒, 默认 30 分钟) |
| `EXPOSE_RAW_URL` | `0` | 设为 `1` 时 `/url` 返回原始 m3u8 URL |
| `UPSTREAM_PROXY` | 空 | 可选 HTTP、HTTPS 或 SOCKS5 代理地址；API、HLS 清单和分片统一使用该出口，例如 `http://127.0.0.1:18092` |
| `KK_RELAY_BASE` | `https://kk.conef1.ggff.net` | Cloudflare Worker 媒体中转。m3u8/分片走 `/p/hls/?u=`；空字符串则直连 CDN |
| `KK_RELAY_API` | 空 (直连) | API 是否走 Worker `/p/api`。默认直连 `kapi`（Worker 出口可能被 WAF 403）；`1` 启用中转 |
| `BROWSER_CDP_URL` | 空 | 外接浏览器 CDP，如 `ws://127.0.0.1:9222`（Obscura） |
| `OBSCURA` | 空 | 设为 `1` 时默认连 `ws://127.0.0.1:9222` |

## 工作原理

服务启动后立即监听端口，后台依次抓取全部配置频道。取源流程参考本地 `smg_fivestar.user.js` v0.23：优先复用最近 30 分钟成功取源的节目，再尝试频道详情。频道详情没有有效地址时，查询当天节目及每轮最多 2 个历史日期，后续重试从下一日期继续，覆盖过去 7 天；节目日期统一使用北京时间。优先尝试已结束、可回看的节目，五星体育优先选择“体育新闻”；不会修改接口返回的节目权限字段。

直播和回看地址都会尝试，回看地址会移除 `start`、`end` 参数作为直播源使用。同一详情内优先尝试有明确到期时间、有效期更长的地址，同等条件下优先回看源。支持 `token` 及其他查询参数中的 JWT，以及 `volcTime`、`wsTime`、`expires` 等秒或毫秒时间戳，取最早的到期时间。地址必须尚有超过 5 秒的有效期且实际返回 HLS 清单才会写入缓存。浏览器抓取与分片代理使用相同的 User-Agent 和出口 IP。

每轮抓取结束后等待 10 秒，再检查各频道缓存。刷新提前量按地址寿命的 15% 计算，限制在 15–120 秒；达到 `CAPTURE_INTERVAL` 也会刷新。无到期时间的地址按抓取后 20 分钟计算。失败保留旧缓存，至少间隔 60 秒重试；多频道串行抓取时，重试会等待当前频道完成。API 请求串行执行，两次请求开始时间至少间隔 800 毫秒。

页面 API 请求出现 `Failed to fetch`、HTTP 错误或非 JSON 响应时，会参考脚本的 `GM_xmlhttpRequest` 机制，改用 Playwright HTTP 客户端兜底，保留签名、浏览器 Cookie、`M-Uuid` 和相同 User-Agent。该路径不受页面 CORS/CSP 限制，回看网页无法加载时也会尝试直接请求 API。页面请求超时为 12 秒，直接请求超时为 15 秒；两条路径都失败时，日志会保留各自的网络错误或 HTTP 状态，便于排查 OpenWrt 容器的连接问题。

如果上游直接返回 WAF 403，切换请求方式可能仍被拒绝。可通过 `UPSTREAM_PROXY` 指定可用线路，浏览器、API 兜底、HLS 验证和实际分片下载会统一使用该代理，保持播放令牌绑定的出口 IP 一致。`host` 网络的容器可使用路由器上的 `127.0.0.1` 代理入口；`bridge` 网络需填写容器可访问的代理地址。HTTP 代理支持用户名和密码，SOCKS5 需使用无认证代理。

`/status` 和 `/url` 的 `usable` 表示地址是否仍在有效期内，`/status` 的 `effectiveExp` 包含无到期时间地址的保守期限。健康检查使用同一判断。频道列表以“未捕获”标记缺少地址的频道，以“待刷新”标记已失效的地址。

都市频道清单中的动态 `100ycdn.com` 分片使用代理生成的签名授权，无需向 `ALLOWED_SEGMENT_HOSTS` 添加通配域名；未经签名的动态地址仍会被拒绝。

主清单、子清单及 `URI` 属性中的密钥、初始化分片地址都会经过代理改写。补源优先寻找长期有效的回看地址；找到可播放的直播地址后，最多再用约 15 秒寻找回看源，避免不可回看的频道拖延整轮抓取。

`smg_fivestar.user.js` 仅作为本地参考，已加入 Git 和 Docker 构建上下文的忽略规则；运行服务和执行测试均不依赖该文件。

```mermaid
flowchart TB
  subgraph docker["Docker 容器"]
    capture["Playwright (按有效期刷新)<br/>复用取源节目 → 频道详情 → 分轮查询节目<br/>浏览器限速发送签名请求，Node.js RSA 解码<br/>验证 m3u8 后保存独立频道缓存"]
    proxy["Node.js 代理<br/>/wx.m3u 返回全部频道 M3U 播放列表<br/>/?id=X 返回单频道 m3u8 (带 Referer)<br/>/seg?u=.. 流式代理 .ts 分片 (带缓存)"]
  end

  capture --> proxy
  proxy --> ip["出口 IP 和 User-Agent 与抓取一致"]
  ip --> cdn["CDN (volc/ws/tencent)<br/>IP 校验通过 ✅"]
```

## 管理

```bash
# 查看状态
curl http://localhost:53535/status

# 查看日志
docker compose logs -f

# 手动刷新 m3u8
docker compose exec kk-proxy node src/vps-capture.js

# 手动刷新指定频道
docker compose exec -e CHANNEL_ID=4 kk-proxy node src/vps-capture.js

# 重启
docker compose restart

# 停止
docker compose down
```

## GitHub Actions (CI/CD)

推送到 `main` 或创建 tag 时自动构建 Docker 镜像:

```
ghcr.io/c0nef/kankenews-hls-proxy:latest
ghcr.io/c0nef/kankenews-hls-proxy:1.0.0
```

Fork 后使用:
1. Fork 本项目
2. **Settings → Actions → Workflow permissions** → Read and write
3. 推送代码,Actions 自动构建
4. 修改 `docker-compose.yml` 中的镜像地址

## 技术细节

详见 [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)

| 技术 | 实现 |
|---|---|
| API 签名 | 双 MD5 + 硬编码密钥 |
| 流地址解密 | RSA 公钥原始运算 (c^e mod n) |
| 分片代理 | 流式传输 + 异步缓存 + 唯一临时文件 |
| 缓存清理 | 每 20 次请求清理一次,防 OOM |
| 多频道 | `?id=X` 参数,每频道独立缓存 |
| 并发安全 | `crypto.randomUUID()` 临时文件 + 原子 rename |

## License

MIT License - 详见 [LICENSE](LICENSE)
