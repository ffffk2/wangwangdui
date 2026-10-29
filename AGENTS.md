# AGENTS.md — 影视工具（wangwangdui）

本地影视工具：爬取 maccms 采集站资源生成片库 JSON，本地 HTTP 服务 + 浏览器播放（BS 架构）。**零第三方依赖**，仅 Node 标准库，需 Node ≥ 14，跨平台（win/mac/linux）。完整背景（播放性能设计、可用采集源清单、排卡顿方法）见 `README.md`。

## 默认资源与搜索约定（重要）

- **默认资源入口（TVBox 多仓）**：`https://gh-proxy.com/https://raw.githubusercontent.com/noimank/tvbox/master/tvboxmuti.json`
- **约定**：用户只说片名（如"搜一下XX""把XX爬进片库"）而未指定资源时，默认以该多仓为入口解析资源链并搜索，**不要让用户重复贴地址**。
- 公司网络直连 `gh-proxy.com` 会被防火墙拦（返回 Fortinet 拦截页），改用镜像：把前缀换成 `https://ghproxy.net/` 或用 `https://cdn.jsdelivr.net/gh/noimank/tvbox@master/tvboxmuti.json`。
- 多仓 → 子配置 → 采集源：部分子配置是 AES 加密（`2423` 开头 hex，如饭太硬/南风/无意，暂不支持）；明文子配置中已验证可用的 maccms 搜索接口清单见 README「资源来源」。**当前默认爬取源 = 暴风** `https://bfzyapi.com/api.php/provide/vod/`。
- 直链特征：暴风/光速/百度/360 为静态路径较稳；量子/非凡带 `sign` 会过期。《汪汪队》23 分钟即完整一集（"52 集"实为 26 集重复）。

## 目录与职责

- `crawl.js` — 爬虫：maccms API（`?ac=videolist`）搜索 + 逐条拉详情 → `resources/<关键词>/<源>.json`
- `server.js` — 全部后端：静态页 + `/api/*` + `/proxy`（m3u8 反代、重写、分片预取/磁盘缓存）
- `public/` — 前端（原生 JS，无框架无构建）：`app.js` / `index.html` / `style.css`；`vendor/hls.min.js` 为本地内置 hls.js，离线可用
- `resources/**/*.json` — 片库数据（爬虫产物，支持任意层级子目录）
- `cache/` — 分片磁盘缓存（运行时自动生成）：播过的分片按 URL 落盘，重看秒播；`CACHE_DIR` 可改位置
- `data/history.json` — 观看历史/进度（运行时自动生成）；`data/config.json` 记录上次缓存目录（改 `CACHE_DIR` 时启动自动 mv 迁移）；`data/cache-tasks.json` 记录手动缓存任务状态

## 常用命令

无构建、无 lint、无测试；`npm install` 不需要（package.json 无依赖）。

```bash
node crawl.js                # 爬默认关键词"汪汪队"@暴风源 → resources/汪汪队/baofeng.json
node crawl.js --kw=猪猪侠     # 换关键词；--api=<maccms接口> 换源；--keep-all 保留解说/预告条目
node server.js               # 启动服务，默认 0.0.0.0:8686，自动开浏览器
PORT=9000 HOST=127.0.0.1 NO_OPEN=1 node server.js
```

验证：起服务后访问 http://127.0.0.1:8686 手动检查；`curl -s http://127.0.0.1:8686/api/library` 可快速确认片库加载。

## 架构边界与关键设计

- 播放链路：`播放器 → /proxy?url=<上游> → 采集站CDN`。m3u8 返回前被 `rewriteM3u8` 重写：分片与内嵌 URI 全部换成代理地址，并记录分片顺序（`segOrder`/`segIndex`）供预取定位。
- 分片缓存（server.js）：内存 LRU `segCache`（上限 60 片）+ 磁盘持久缓存（默认 `<项目>/cache`，`CACHE_DIR` 可改、落盘总量默认不限，`CACHE_MAX_MB` 可设上限、超限最久未用淘汰）+ `fetchSegment` 单飞去重 + `prefetchAround` 预取后 3 片；分片按 URL 的 sha1 落盘 `cache/seg/<hash前2位>/`，写盘异常自动停用不影响播放；改 `CACHE_DIR` 启动时把旧目录 mv 到新目录（上次目录记录在 `data/config.json`）。m3u8 播放列表文本同样落盘 `cache/m3u8/`（TTL 默认 6 小时 `M3U8_CACHE_HOURS`，出口仍走 `rewriteM3u8` 登记 segOrder；代理与手动缓存任务共用 `getM3u8Text`），重看时启动零回源。前端 hls 配置 `maxBufferLength: 60`。调整这些参数需同步更新 README 的性能表格。
- 手动缓存（server.js + app.js）：详情页/播放页点分集角标或"全部缓存"→ `POST /api/cache/task`（start/cancel/remove）进入 FIFO 任务队列；`fetchPlaylistSegments` 解析该集 m3u8（主 playlist 递归进第一个子档）取全部片段 URL，片内 4 并发复用 `fetchSegment` 落盘。同一时刻只下载一集（不挤占播放带宽）；任务记录持久化在 `data/cache-tasks.json`（重启时 running/queued 标记为中断），前端 2s 轮询 `/api/cache/tasks` 刷新角标（⬇/排队/x/y/✓/!）。
- 片库即时生效：`/api/library` 每次请求都递归重扫 `resources/**/*.json`，新增/修改片库文件无需重启服务。
- 影片 `file` 标识 = 相对 `resources/` 的 **posix 风格**路径（`path.sep` 统一替换为 `/`），跨平台一致；`/api/video` 用 `file` + `id` 定位。
- 历史进度：前端每 5 秒 POST `/api/history`（action=save）；key 为 `file::videoId`，字段结构见 server.js 的 save 分支。

## 约定与坑

- **不要引入第三方依赖、不要加构建步骤**；新功能用 Node 标准库 + 原生前端 JS 实现。
- 上游请求刻意设置 `rejectUnauthorized: false`（公司网络 TLS 劫持）和 UA `okhttp/3.15`（绕防盗链）——不是 bug，别"修复"。
- `crawl.js` 的 `sortKey()` 含汪汪队专属排序规则（第N季=1~10，小砾与工程家族=100、海陆空=110、萌宠/番外=120、大电影=201+，其余=500），爬其他关键词时仅作兜底。
- 部分采集源把分片伪装成图片后缀（如百度源 `.jpeg`）。`handleProxy` 判分片（isSeg）除扩展名外还有 `segIndex.has(target)` 兜底（playlist 重写时登记全部真实分片 URL），改这段别只认扩展名，否则缓存/预取整体失效、退化成直通。
- `serveStatic` 用 `startsWith(PUBLIC)` 防路径穿越，改静态路由时保持该防护。
- 注释与日志用中文，与现有风格保持一致。
