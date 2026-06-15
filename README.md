# kankanews-hls-proxy

将看看新闻(kankanews)的 HLS 直播/回看流代理出来,供 PotPlayer、VLC、hls.js 等播放器使用。

## 快速开始

```bash
# 1. 拉取镜像
docker pull ghcr.io/conef404/kankenews-hls-proxy:latest

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
| `/url` | JSON 返回当前缓存的 m3u8 URL |

## 部署场景

### 1. 服务器 / NAS / 电脑

```bash
git clone https://github.com/conef404/kankanews-hls-proxy.git
cd kankanews-hls-proxy
docker compose up -d
```

PotPlayer: `http://<设备IP>:53535/wx.m3u` (频道列表)

### 2. OpenWrt 路由器 (需安装 Docker)

```bash
opkg update && opkg install dockerd docker
service dockerd start && service dockerd enable

docker pull ghcr.io/conef404/kankenews-hls-proxy:latest
docker run -d \
  --name kk-hls-proxy \
  --restart unless-stopped \
  -p 53535:3000 \
  -e CHANNEL_ID=10 \
  -e MAX_CACHE_SIZE=268435456 \
  --security-opt seccomp=unconfined \
  ghcr.io/conef404/kankenews-hls-proxy:latest
```

PotPlayer: `http://192.168.1.1:53535/wx.m3u` (频道列表)

### 3. 群晖 NAS

1. **Container Manager** → **映像** → 拉取 `ghcr.io/conef404/kankenews-hls-proxy:latest`
2. **容器** → 新建:
   - 端口: `53535` → `3000`
   - 环境变量: `CHANNEL_ID=10`
   - 高级设置: `--security-opt seccomp=unconfined`
3. 启动

PotPlayer: `http://<NAS IP>:53535/wx.m3u` (频道列表)

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `CHANNEL_ID` | `10` | 默认频道 ID |
| `PORT` | `3000` | 容器内端口 |
| `CAPTURE_INTERVAL` | `36000000` | m3u8 捕获间隔 (毫秒, 默认 10 小时) |
| `MAX_CACHE_SIZE` | `1073741824` | 最大分片缓存 (字节, 默认 1GB) |
| `MAX_CACHE_AGE` | `1800` | 缓存过期时间 (秒, 默认 30 分钟) |

## 工作原理

```
┌─────────────────────── Docker 容器 ────────────────────────┐
│                                                             │
│  Playwright (每 10 小时)                                    │
│  → 打开 kankanews 回看页面                                  │
│  → 浏览器 JS 自动完成 API 签名 + RSA 解密                   │
│  → 截获 m3u8 URL (JWT 绑定容器出口 IP)                     │
│                                                             │
│  Node.js 代理                                               │
│  → /wx.m3u    返回全部频道 M3U 播放列表                     │
│  → /?id=X     返回单频道 m3u8 (带 Referer)                  │
│  → /seg?u=..  流式代理 .ts 分片 (带缓存)                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ 出口 IP = JWT user_ip ✅
                              ▼
                     CDN (volc-stream.kksmg.com)
                     IP 校验通过 ✅
```

## 管理

```bash
# 查看状态
curl http://localhost:53535/status

# 查看日志
docker compose logs -f

# 手动刷新 m3u8
docker compose exec kk-hls-proxy node src/vps-capture.js

# 重启
docker compose restart

# 停止
docker compose down
```

## GitHub Actions (CI/CD)

推送到 `main` 或创建 tag 时自动构建 Docker 镜像:

```
ghcr.io/conef404/kankenews-hls-proxy:latest
ghcr.io/conef404/kankenews-hls-proxy:1.0.0
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
