# 影视工具（wangwangdui）

基于 Node.js 的本地影视工具（BS 架构）：爬取采集站资源生成配置文件，浏览器播放，支持搜索、自动连播、观看历史与断点续播。**零第三方依赖**，Windows / macOS / Linux 均可运行（需 Node ≥ 14）。

## ★ 默认资源入口

```
https://gh-proxy.com/https://raw.githubusercontent.com/noimank/tvbox/master/tvboxmuti.json
```

这是 TVBox 多仓配置，内含 14 个子配置（各子配置再聚合若干采集源）。**约定：只要说"搜索/爬取某片名"而未指定资源，就默认以这个多仓为入口解析资源**。说明：

- 公司网络直连 `gh-proxy.com` 会被防火墙拦（返回 Fortinet 拦截页），改用镜像即可，如：
  `https://ghproxy.net/https://raw.githubusercontent.com/noimank/tvbox/master/tvboxmuti.json`
  或 `https://cdn.jsdelivr.net/gh/noimank/tvbox@master/tvboxmuti.json`
- 子配置中部分是加密配置（`2423...` 开头的 AES，如饭太硬/南风/无意，当前不支持），其余明文配置已解析验证，可用源见下表
- 当前爬虫默认源 = 多仓中验证最稳的**暴风源**

## 目录结构

```
wangwangdui/
├── crawl.js            # 爬虫: 采集站API → resources/<关键词>/<源>.json
├── server.js           # 播放服务: 静态页面 + API + m3u8 反向代理(含分片预取缓存)
├── package.json
├── public/             # 前端页面(BS 架构的 B 端)
│   ├── index.html / app.js / style.css
│   └── vendor/hls.min.js   # 本地内置, 离线可用
├── resources/          # ★ 片库(多目录递归扫描) — 爬虫产出放这里
│   ├── 汪汪队/
│   │   └── baofeng.json    # 暴风源爬取结果(含完整字段与全部分集)
│   ├── 小猪佩奇/
│   │   ├── baofeng.json    # 暴风源(第九/十一/十二季+剧场版)
│   │   └── baidu.json      # 百度+光速源(第一~八/十季+《完美假期》)
│   └── 布鲁伊/
│       └── guangsu.json    # 光速源(一~三季原声+普通话版)
├── cache/              # ★ 分片磁盘缓存(自动生成) — 播过的分片落盘, 重看/重启后秒播
└── data/
    ├── history.json    # 观看历史/进度(自动生成)
    └── config.json     # 本地配置(记录上次缓存目录, 改目录时自动迁移)
```

## 快速开始

```bash
# 1. 爬取资源(默认爬"汪汪队"@暴风源)
node crawl.js

# 2. 启动播放服务(自动打开浏览器)
node server.js
#    打开 http://127.0.0.1:8686
```

## 常用命令

| 命令 | 说明 |
|---|---|
| `node crawl.js` | 爬"汪汪队"@暴风源 → `resources/汪汪队/baofeng.json` |
| `node crawl.js --kw=猪猪侠` | 爬其他关键词 |
| `node crawl.js --api=<maccms接口> --kw=xx` | 换采集源(任意苹果CMS v10 接口) |
| `node crawl.js --kw=xx --keep-all` | 保留[电影解说]/[预告片]条目 |
| `node crawl.js --out=resources/电影/x.json` | 自定义输出位置 |
| `node server.js` | 启动服务, 默认 0.0.0.0:8686 |
| `PORT=9000 node server.js` | 自定义端口 |
| `HOST=127.0.0.1 node server.js` | 仅本机可访问 |
| `NO_OPEN=1 node server.js` | 不自动打开浏览器 |
| `CACHE_DIR=D:/video-cache node server.js` | 分片缓存放别处(相对路径按项目目录解析), 启动时自动把旧缓存整个 mv 到新目录 |
| `CACHE_MAX_MB=8192 node server.js` | 磁盘缓存上限 MB(默认不限, 超限按最久未用淘汰; 想限制磁盘占用时再设) |
| `M3U8_CACHE_HOURS=12 node server.js` | m3u8 播放列表本地缓存时长(默认 6 小时, 0=不缓存) |

## 多目录片库

`resources/` 下支持任意层级的子目录，服务启动时递归扫描全部 `*.json` 合并为片库，页面按**一级目录名**分组展示。以后更新影视资源：

```bash
node crawl.js --kw=新片名          # 会生成 resources/新片名/baofeng.json
```

刷新页面即可看到，**无需重启服务**。手动整理目录（如 `resources/儿童/汪汪队/baofeng.json`）也没问题。

**多源补全一部片**：默认源缺季/缺集时，换源再爬（`--api=... --name=xx --label=xx源`）输出到同一目录即可，页面会合并展示。注意同名条目会重复出卡，需手动去重——保留集数全的源、删掉残缺文件（实际案例：小猪佩奇=暴风9/11/12季+百度1~7/10季+光速第八季；布鲁伊=光速原声+普通话版，暴风第三季缺一半故舍弃）。片库 JSON 内的 `videos` 数组顺序即展示顺序，可按季号手动重排。

## 资源来源（已验证可用的采集源）

均解析自上面的**默认资源入口**（tvboxmuti.json 多仓）。各源的标准 maccms 搜索接口（`?ac=videolist&wd=关键词`）：

| 源 | API | 备注 |
|---|---|---|
| 暴风 | `https://bfzyapi.com/api.php/provide/vod/` | **当前爬虫默认源**，静态直链最稳 |
| 光速 | `https://api.guangsuapi.com/api.php/provide/vod/from/gsm3u8/` | 链接短且稳，但集数偏少 |
| 百度 | `https://api.apibdzy.com/api.php/provide/vod/` | 集数全（第一季26集全） |
| 360 | `https://360zy.com/api.php/provide/vod/` | 电影/特别篇较全 |
| 量子 | `http://cj.lziapi.com/api.php/provide/vod/` | 画质好，直链带 sign 会过期 |
| 非凡 | `http://cj.ffzyapi.com/api.php/provide/vod/` | 同量子 |
| 创享 | `https://ys.cxkjg.cn/api/provide/vod/` | 分集编号混乱，慎用 |
| 速播 | `https://subocaiji.com/api.php/provide/vod/` | 备用 |

换源爬取：`node crawl.js --api=<上表地址> --kw=汪汪队 --label=<源名>`

## 功能

- **片库/搜索**：按目录分组展示，顶部搜索框按片名/年份/主演即时过滤
- **播放**：内置 hls.js 播放 m3u8；服务端反向代理分片，解决跨域/防盗链问题
- **本地磁盘缓存**：播放过的分片自动落盘（默认 `cache/` 目录，`CACHE_DIR` 可改位置），重看同一集时直接命中本地秒播，重启服务缓存仍在；`GET /api/cache` 可查用量
- **手动缓存**：详情页/播放页点分集右下角角标缓存单集，或"全部缓存"把整季加入队列；后台逐集预下载（不用先播放），完成显示 ✓，之后重看全程秒加载；进度/取消/重试都在角标上
- **自动连播**：一集播完 5 秒倒计时自动播下一集（可取消/可关闭开关）
- **观看历史**：每 5 秒记录播放进度；换集/关机后再进自动跳到上次的集数和时间点；支持单条删除/清空
- **续播**：详情页显示"续播 第x集"，历史页一键继续

## 播放链路与性能设计（重要）

播放走的是本地代理：`播放器 → http://127.0.0.1:8686/proxy?url=<m3u8/分片> → 采集站CDN`。
代理做了三层优化，解决"CDN 慢导致卡顿"的问题（针对暴风源实测数据）：

| 层 | 位置 | 作用 | 实测效果 |
|---|---|---|---|
| keep-alive 连接池 | server.js `HTTPS_AGENT` | 复用 TLS 连接，消除每片握手延迟 | 单片 1.5~1.9s → 0.3~0.7s |
| 分片预取缓存 | server.js `fetchSegment/prefetchAround` | 每请求 1 片，后台预抓后 3 片入内存 LRU（上限 60 片≈18MB），下次请求零等待 | 串行取 6 片 9.2s → 0.05s |
| 磁盘持久缓存 | server.js `diskRead/diskWrite` | 播过的分片按 URL 落盘（默认 `cache/`，总量默认不限，可用 `CACHE_MAX_MB` 限 MB、超限最久未用淘汰），内存/预取未命中先查磁盘 | 重看/重启后命中本地秒播，不再回源 |
| m3u8 本地缓存 | server.js `getM3u8Text` | 播放列表文本也落盘（`cache/m3u8/`，TTL 默认 6 小时 `M3U8_CACHE_HOURS`），重看时 playlist 不回源、分片全命中磁盘 | 缓存过的集启动≈纯本地，无"现场取流"延迟 |
| 前向缓冲 60s | public/app.js hls 配置 `maxBufferLength:60` | 加大抗抖动余量 | 播放 25s 后缓冲拉满 60s |

背景知识（排查卡顿时实测得出，换源后若又卡可参照）：

- 暴风 CDN 把一集 23 分钟拆成 **约 1400 个 1 秒分片**，冷连接（每次新建 TLS）取一片要 1.5s 以上
  ——串行拉片只有 0.67 倍实时速度，必然卡顿；且 CDN 会掐断频繁新建的连接
- hls.js 默认**串行**加载分片，所以必须靠"连接复用 + 预取"把下载速度提到实时以上
- 拖动进度条跳很远的位置时预取链会重建，头一两秒短暂缓冲属正常

## 配置文件字段（resources/**/*.json）

```jsonc
{
  "source": { "name": "暴风资源", "api": "...", "keyword": "汪汪队", "crawledAt": "...", "count": 15, "totalEpisodes": 300 },
  "videos": [{
    "id": "114450", "name": "汪汪队立大功第一季", "type": "动漫", "year": "2014",
    "area": "内地", "lang": "国语", "actor": "...", "director": "...", "score": "...",
    "remark": "...", "pic": "海报URL", "content": "简介", "updated": "资源最后更新时间",
    "groups": [{ "from": "bfm3u8", "episodes": [{ "name": "第1集", "url": "https://.../index.m3u8" }] }],
    "episodeCount": 23
  }]
}
```

## 跨平台说明（mac）

- 全部代码只用了 Node 标准库，路径统一 posix 风格，Mac 上 `node crawl.js` / `node server.js` 直接运行
- 默认监听 `0.0.0.0`，同一 WiFi 下的电视/手机/平板可通过 `http://<Mac的IP>:8686` 访问；只想本机用就 `HOST=127.0.0.1 node server.js`
- 公司网络做了 TLS 劫持，代码里对采集站请求跳过了证书校验（`rejectUnauthorized: false`），仅用于访问公开采集 API

## 已知说明

- 采集站直链可能因 CDN 失效而挂掉，重跑 `node crawl.js` 刷新即可
- 暴风源为公开采集站，播放质量/可用性以其服务为准
- 量子/非凡等源的直链带 `sign` 参数会过期，暴风/光速/百度/360 源为静态路径较稳定
- 磁盘缓存以分片 URL 为 key：静态直链源（暴风/光速/百度/360）重看必命中；量子/非凡等带 `sign` 的链接过期换新后 URL 变了不命中（旧分片会在容量压力下被淘汰）
- m3u8 播放列表缓存默认 6 小时（`M3U8_CACHE_HOURS` 可调，0=关闭）；带 `sign` 的源若 sign 比 TTL 先过期，播放会先报错、到 TTL 自动恢复，可把 TTL 调小或设 0
- 《汪汪队立大功》各季**每集约 22~23 分钟是完整一集**（含两个 11 分钟小故事）；量子/非凡源标称"52 集"实为 26 集重复两遍，全季就是 26 大集
- 换了新采集源后如果又出现卡顿：大概率该源也是"小分片+慢冷连接"型，本代理的预取机制会自动生效，无需改动；若仍卡，按下面的方法快速定位

## 排查卡顿的快速方法

```bash
# 取某集 m3u8 看分片规模: TARGETDURATION 是单片时长(秒), 行数是分片数量
curl -sk "https://<源的分片m3u8地址>" | head -5
# 计时取几片: 若"单片耗时 > 单片时长"且分片只有 1~2s 视频 => 慢CDN, 确认代理 keep-alive/预取正常即可
```
