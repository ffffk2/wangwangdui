/**
 * server.js — 本地影视播放服务(零依赖, BS 架构, 跨平台 win/mac/linux)
 *
 * 用法:
 *   node server.js                       # 默认 http://<LAN_IP>:8686
 *   PORT=9000 node server.js             # 自定义端口
 *   HOST=127.0.0.1 node server.js        # 仅本机访问
 *   NO_OPEN=1 node server.js             # 不自动打开浏览器
 *   CACHE_DIR=D:/video-cache node server.js  # 分片磁盘缓存目录(默认 <项目>/cache, 改目录启动时自动迁移旧缓存)
 *   CACHE_MAX_MB=2048 node server.js     # 磁盘缓存上限(默认 4096MB, 0=不限)
 *
 * 资源结构(多目录, 递归扫描):
 *   resources/<任意子目录>/<片库>.json    # crawl.js 生成; 新增文件刷新页面即生效
 *
 * 接口:
 *   GET  /api/library                    片库(递归合并 resources 下全部 .json)
 *   GET  /api/video?file=&id=            影片详情+分集+观看进度
 *   GET  /api/history                    观看历史
 *   POST /api/history                    {action:'save'|'remove'|'clear',...}
 *   GET  /api/cache                      磁盘缓存状态(目录/分片数/用量/上限)
 *   GET  /api/cache/tasks                手动缓存任务列表(整集预下载进度)
 *   POST /api/cache/task                 手动缓存: {action:'start'|'cancel'|'remove', file, videoId, groupIndex, episodeIndex}
 *   GET  /proxy?url=                     m3u8/ts 反向代理(解决跨域/防盗链)
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const { URL } = require('url');

const PORT = +process.env.PORT || 8686;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const RES_DIR = path.join(__dirname, 'resources');
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
// 磁盘分片缓存目录: 默认 <项目>/cache, CACHE_DIR 可改(相对路径按项目目录解析)
const CACHE_DIR = path.resolve(__dirname, process.env.CACHE_DIR || 'cache');
const CACHE_SEG_DIR = path.join(CACHE_DIR, 'seg');
// 落盘总量上限(字节), CACHE_MAX_MB 可改(0=不限); 超限按最久未用淘汰
const rawMaxMb = parseFloat(process.env.CACHE_MAX_MB);
const CACHE_MAX_BYTES = (Number.isFinite(rawMaxMb) && rawMaxMb >= 0 ? rawMaxMb : 4096) * 1024 * 1024;

const UA = 'okhttp/3.15';
// keep-alive 连接池: 复用 TLS 连接, 消除每片 1.5s 的握手延迟(实测降到 0.3-0.7s)
const HTTPS_AGENT = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true, keepAliveMsecs: 30000,
  maxSockets: 16, maxFreeSockets: 8,
});
const HTTP_AGENT = new http.Agent({
  keepAlive: true, keepAliveMsecs: 30000,
  maxSockets: 16, maxFreeSockets: 8,
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

/* ---------------- 片库: 递归扫描 resources 下的 .json ---------------- */
function walkJsonFiles(dir, base) {
  let out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out = out.concat(walkJsonFiles(full, base));
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.json')) {
      // file 标识统一为 posix 风格相对路径, 跨平台一致
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out.sort();
}

function loadLibraries() {
  const libs = [];
  for (const relFile of walkJsonFiles(RES_DIR, RES_DIR)) {
    try {
      const conf = JSON.parse(fs.readFileSync(path.join(RES_DIR, ...relFile.split('/')), 'utf8'));
      const videos = (conf.videos || []).map(v => ({ ...v, lib: relFile }));
      libs.push({
        file: relFile,
        dir: path.posix.dirname(relFile) === '.' ? '' : path.posix.dirname(relFile),
        source: conf.source || {},
        videos,
      });
    } catch (e) {
      console.error(`配置文件解析失败 ${relFile}: ${e.message}`);
    }
  }
  return libs;
}

/* ---------------- 历史/进度 ---------------- */
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); }
  catch { return { items: {} }; }
}
function saveHistory(h) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(h, null, 1), 'utf8');
}

/* ---------------- 本地配置(记录上次缓存目录, 供改目录时自动迁移) ---------------- */
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig(conf) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(conf, null, 1), 'utf8');
}

/* ---------------- 上游请求 ---------------- */
function upstream(target, extraHeaders, cb) {
  const u = new URL(target);
  const mod = u.protocol === 'http:' ? http : https;
  const headers = { 'User-Agent': UA, ...(extraHeaders || {}) };
  const req = mod.get(target, {
    headers,
    agent: u.protocol === 'https:' ? HTTPS_AGENT : HTTP_AGENT,
    timeout: 25000,
  }, cb);
  req.on('timeout', () => req.destroy(new Error('upstream timeout')));
  return req;
}

/* ---------------- 分片预取缓存 ----------------
 * 该 CDN 每片约 1s 视频但冷连接要 1.5s+, 播放器串行拉片必然卡顿。
 * 策略: 播放器每请求一片, 后台预抓其后 3 片入内存 LRU,
 *       下一次请求直接命中缓存(≈0ms), 预取链持续跑在播放前面。 */
const SEG_CACHE_MAX = 60;      // 最多缓存分片数(约 18MB)
const PREFETCH_AHEAD = 3;
const segCache = new Map();    // url -> Buffer
const segMeta = new Map();     // url -> content-type
const segInflight = new Map(); // url -> Promise<Buffer>
const segOrder = new Map();    // playlistUrl -> [segmentUrl, ...]
const segIndex = new Map();    // segmentUrl -> { pl, i }

function cachePut(url, buf, ct) {
  if (segCache.has(url)) segCache.delete(url);
  segCache.set(url, buf);
  segMeta.set(url, ct || 'video/mp2t');
  while (segCache.size > SEG_CACHE_MAX) {
    const k = segCache.keys().next().value;
    segCache.delete(k);
    segMeta.delete(k);
  }
}

function loadSegment(url) { // 内存未命中 → 磁盘持久缓存 → 回源(成功后双写内存+磁盘)
  return diskRead(url).then(buf => {
    if (buf) { cachePut(url, buf, 'video/mp2t'); return buf; }
    return new Promise((resolve, reject) => {
      upstream(url, null, up => {
        const chunks = [];
        up.on('data', c => chunks.push(c));
        up.on('end', () => {
          const b = Buffer.concat(chunks);
          cachePut(url, b, up.headers['content-type']);
          if (up.statusCode === 200) diskWrite(url, b); // 非 200(防盗链页/404)不落盘
          resolve(b);
        });
        up.on('error', reject);
      }).on('error', reject);
    });
  });
}

function fetchSegment(url) {
  if (segCache.has(url)) return Promise.resolve(segCache.get(url));
  if (segInflight.has(url)) return segInflight.get(url);
  const p = loadSegment(url).then(
    buf => { segInflight.delete(url); return buf; },
    e => { segInflight.delete(url); throw e; }
  );
  segInflight.set(url, p);
  return p;
}

function diskTouch(url) { // 磁盘已有该分片: 挪到 LRU 末尾续命, 返回是否命中
  if (diskDisabled) return false;
  const key = segUrlKey(url);
  if (!diskFiles.has(key)) return false;
  const size = diskFiles.get(key);
  diskFiles.delete(key);
  diskFiles.set(key, size);
  return true;
}

function prefetchAround(segUrl) {
  const pos = segIndex.get(segUrl);
  if (!pos) return;
  const list = segOrder.get(pos.pl);
  if (!list) return;
  for (let k = pos.i + 1; k <= Math.min(pos.i + PREFETCH_AHEAD, list.length - 1); k++) {
    const u = list[k];
    if (segCache.has(u) || segInflight.has(u) || diskTouch(u)) continue; // 内存/在途/磁盘已有: 跳过
    fetchSegment(u).catch(() => {});
  }
}

/* ---------------- 磁盘持久缓存 ----------------
 * 内存 LRU 只存 60 片热数据, 重启/隔天重看仍要回源。
 * 播过的分片按 URL 为 key 落盘 cache/seg/<hash前2位>/<sha1>.ts,
 * 再次请求先查磁盘(毫秒级), 重复观看/重启后都秒播。
 * 总量超 CACHE_MAX_MB 按"最久未用"淘汰; 磁盘异常自动停用落盘, 不影响播放。 */
const segUrlKey = url => {
  const h = crypto.createHash('sha1').update(url).digest('hex');
  return h.slice(0, 2) + '/' + h + '.ts';
};
const diskFiles = new Map();   // 分片相对路径 -> 字节数(插入顺序即新旧, 头部最久未用)
const diskShards = new Set();  // 已就绪的二级目录, 避免重复 mkdir
let diskBytes = 0;             // 落盘分片总大小(内存记账, 启动时扫描校准)
let diskDisabled = false;      // 磁盘异常(满/无权限)后停用落盘, 播放退回纯内存+回源

const diskPath = key => path.join(CACHE_SEG_DIR, key);

function diskRead(url) {
  if (diskDisabled) return Promise.resolve(null);
  return fs.promises.readFile(diskPath(segUrlKey(url))).then(buf => {
    diskTouch(url);
    return buf;
  }).catch(() => null);
}

function diskWrite(url, buf) {
  if (diskDisabled) return;
  const key = segUrlKey(url);
  const full = diskPath(key);
  const shard = path.dirname(full);
  if (!diskShards.has(shard)) {
    try { fs.mkdirSync(shard, { recursive: true }); diskShards.add(shard); }
    catch (e) { diskDisabled = true; return console.error(`缓存目录创建失败(${e.message}), 磁盘缓存停用`); }
  }
  fs.promises.writeFile(full, buf).then(() => {
    if (diskFiles.has(key)) diskBytes -= diskFiles.get(key);
    diskFiles.set(key, buf.length);
    diskBytes += buf.length;
    evictDisk();
  }).catch(e => {
    diskDisabled = true;
    console.error(`分片写盘失败(${e.message}), 磁盘缓存停用`);
  });
}

function evictDisk() {
  if (!CACHE_MAX_BYTES || diskBytes <= CACHE_MAX_BYTES) return;
  for (const [key, size] of diskFiles) { // Map 遍历按插入顺序: 从最久未用开始淘汰
    if (diskBytes <= CACHE_MAX_BYTES) break;
    diskFiles.delete(key);
    diskBytes -= size;
    fs.promises.unlink(diskPath(key)).catch(() => {}); // 偶发被占用删不掉: 记账已扣, 重启扫描自动校准
  }
}

/* 缓存目录迁移: 上次目录记录在 data/config.json, 与本次 CACHE_DIR 不同则把旧缓存 mv 过去 */
function samePath(a, b) {
  const ra = path.resolve(a), rb = path.resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}
function isInside(parent, child) {
  const r = path.relative(parent, child);
  return r !== '' && !r.startsWith('..') && !path.isAbsolute(r);
}
function moveInto(srcDir, dstDir) { // rename 失败(跨盘/目标已存在)时逐项合并移动
  if (samePath(srcDir, dstDir)) return;
  fs.mkdirSync(dstDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    const s = path.join(srcDir, name), t = path.join(dstDir, name);
    try { fs.renameSync(s, t); continue; } catch {}
    if (fs.statSync(s).isDirectory()) moveInto(s, t);
    else { try { fs.copyFileSync(s, t); fs.unlinkSync(s); } catch {} }
  }
}
function rmTree(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch {}
  try { fs.rmdirSync(dir, { recursive: true }); } catch {}
}
function migrateCacheDir() {
  const conf = loadConfig();
  const oldDir = conf.cacheDir;
  if (oldDir && !samePath(oldDir, CACHE_DIR) && fs.existsSync(oldDir)) {
    if (isInside(CACHE_DIR, oldDir) || isInside(oldDir, CACHE_DIR)) {
      console.error(`缓存目录新旧嵌套(${oldDir} ↔ ${CACHE_DIR}), 跳过迁移, 请改用互不包含的目录`);
    } else {
      console.log(`缓存目录变更: ${oldDir} → ${CACHE_DIR}, 正在迁移...`);
      try {
        fs.mkdirSync(path.dirname(CACHE_DIR), { recursive: true });
        fs.renameSync(oldDir, CACHE_DIR); // 同盘且目标不存在: mv 原子改名, 秒迁
      } catch {
        moveInto(oldDir, CACHE_DIR);      // 跨盘或目标已存在: 逐项合并
        rmTree(oldDir);
      }
      console.log('缓存目录迁移完成');
    }
  }
  saveConfig({ ...conf, cacheDir: CACHE_DIR });
}

/* 启动时扫描落盘分片, 建立大小记账(按 mtime 旧→新 ≈ 最久未用顺序) */
function initDiskCacheStats() {
  const found = [];
  const walk = dir => {
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        try { const st = fs.statSync(full); found.push([full, st.size, st.mtimeMs]); } catch {}
      }
    }
  };
  walk(CACHE_SEG_DIR);
  diskFiles.clear(); diskShards.clear(); diskBytes = 0;
  found.sort((a, b) => a[2] - b[2]);
  for (const [full, size] of found) {
    const rel = path.relative(CACHE_SEG_DIR, full).split(path.sep).join('/');
    diskFiles.set(rel, size);
    diskShards.add(path.dirname(full));
    diskBytes += size;
  }
}

/* ---------------- 手动缓存任务(整集预下载, 不播放也能缓存) ----------------
 * 页面点"缓存"→ 解析该集 m3u8 拿到全部分片 URL → 排队逐集下载(复用
 * fetchSegment, 自动落盘), 之后重看该集时全部命中磁盘秒播。
 * 同一时刻只下载一集(片内 4 并发), 排队 FIFO, 避免挤占播放带宽;
 * 任务记录存 data/cache-tasks.json, 重启后仍显示各集缓存状态。 */
const CACHE_TASKS_FILE = path.join(DATA_DIR, 'cache-tasks.json');
const SEG_TASK_WORKERS = 4;    // 单任务并发取片数
const cacheTasks = new Map();  // key -> 任务(含已完成记录, 供页面显示"已缓存")
const cacheQueue = [];         // 排队中的任务 key(FIFO)
let cacheRunningKey = null;    // 当前正在下载的任务 key

const taskKey = (file, videoId, gi, i) => `${file}::${videoId}::${gi}::${i}`;
const nowStr = () => new Date().toLocaleString('zh-CN', { hour12: false });

function loadCacheTasks() {
  try {
    const conf = JSON.parse(fs.readFileSync(CACHE_TASKS_FILE, 'utf8'));
    for (const [k, t] of Object.entries(conf.items || {})) {
      if (t.status === 'running' || t.status === 'queued') { // 重启前的下载无法续, 标记中断
        t.status = 'error';
        t.error = '服务重启, 任务中断';
      }
      cacheTasks.set(k, t);
    }
  } catch {}
}

function persistCacheTasks() {
  const items = {};
  for (const [k, t] of cacheTasks) items[k] = t;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CACHE_TASKS_FILE, JSON.stringify({ items }, null, 1), 'utf8');
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    upstream(url, null, up => {
      let body = '';
      up.on('data', c => body += c);
      up.on('end', () => up.statusCode === 200 ? resolve(body) : reject(new Error(`HTTP ${up.statusCode}`)));
      up.on('error', reject);
    }).on('error', reject);
  });
}

// 取媒体 playlist 的全部分片绝对 URL; 主 playlist(多码率)递归进第一个子 playlist
async function fetchPlaylistSegments(url, depth = 0) {
  const text = await fetchText(url);
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.some(l => l.startsWith('#EXTINF'))) {
    return lines.filter(l => !l.startsWith('#')).map(l => new URL(l, url).href);
  }
  if (depth < 3) {
    for (const l of lines) {
      let sub = null;
      if (!l.startsWith('#')) sub = l;
      else if (/STREAM-INF/i.test(l)) { const m = l.match(/URI="([^"]+)"/); if (m) sub = m[1]; }
      if (sub) return fetchPlaylistSegments(new URL(sub, url).href, depth + 1);
    }
  }
  throw new Error('playlist 中未找到分片');
}

async function runCacheTask(task) {
  task.status = 'running';
  task.updatedAt = nowStr();
  persistCacheTasks();
  try {
    const segs = await fetchPlaylistSegments(task.url);
    if (diskDisabled) throw new Error('磁盘缓存不可用(写盘失败已被停用)');
    task.total = segs.length;
    let cursor = 0;
    const worker = async () => {
      while (task.status === 'running' && !diskDisabled) {
        const i = cursor++;
        if (i >= segs.length) return;
        let buf;
        try { buf = await fetchSegment(segs[i]); }
        catch {
          await new Promise(r => setTimeout(r, 400)); // CDN 抖动: 重试一次
          try { buf = await fetchSegment(segs[i]); }
          catch (e2) { throw new Error(`第 ${i + 1}/${segs.length} 片下载失败: ${e2.message}`); }
        }
        if (task.status !== 'running') return; // 已取消/移除: 不再计数
        task.done += 1;
        task.bytes += buf.length;
        task.sizeMB = +(task.bytes / 1048576).toFixed(1);
        if (task.done % 100 === 0) persistCacheTasks();
      }
    };
    await Promise.all(Array.from({ length: Math.min(SEG_TASK_WORKERS, segs.length || 1) }, worker));
    if (task.status === 'running') {
      if (diskDisabled) { task.status = 'error'; task.error = '磁盘写入失败, 磁盘缓存已停用'; }
      else task.status = 'done';
    }
  } catch (e) {
    if (task.status === 'running') { task.status = 'error'; task.error = e.message; }
  }
  task.updatedAt = nowStr();
  persistCacheTasks();
}

function pumpCacheQueue() {
  if (cacheRunningKey || !cacheQueue.length) return;
  const key = cacheQueue.shift();
  const task = cacheTasks.get(key);
  if (!task || task.status !== 'queued') return pumpCacheQueue();
  cacheRunningKey = key;
  runCacheTask(task).catch(e => {
    task.status = 'error'; task.error = e.message; task.updatedAt = nowStr(); persistCacheTasks();
  }).finally(() => {
    cacheRunningKey = null;
    pumpCacheQueue();
  });
}

/* ---------------- m3u8 重写 ---------------- */
const wrapProxy = u => '/proxy?url=' + encodeURIComponent(u);

function rewriteM3u8(text, base) {
  const absSegs = [];
  const out = text.split(/\r?\n/).map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (m, uri) => `URI="${wrapProxy(new URL(uri, base).href)}"`);
    }
    const abs = new URL(t, base).href;
    absSegs.push(abs);
    return wrapProxy(abs);
  }).join('\n');
  // 媒体 playlist(含分片)才记录分片顺序, 供预取定位
  if (text.includes('#EXTINF') && absSegs.length) {
    segOrder.set(base, absSegs);
    absSegs.forEach((u, i) => segIndex.set(u, { pl: base, i }));
  }
  return out;
}

/* ---------------- HTTP 基础 ---------------- */
function json(res, code, obj) {
  if (res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const c = [];
    req.on('data', d => c.push(d));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(c).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

function handleProxy(req, res, target) {
  const isM3u8 = /\.m3u8(\?|$)/i.test(target);
  const isSeg = !req.headers.range && !/\.mp4(\?|$)/i.test(target) &&
                (/\.(ts|m4s|aac|trp|buf)(\?|$)/i.test(target) || !/\.[a-z0-9]{2,5}(\?|$)/i.test(target));

  if (isM3u8) {
    upstream(target, null, up => {
      let body = '';
      up.on('data', c => body += c);
      up.on('end', () => {
        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(rewriteM3u8(body, target));
      });
    }).on('error', e => {
      if (!res.headersSent) json(res, 502, { error: e.message });
      else res.destroy();
    });
    return;
  }

  // 媒体分片: 走单飞+缓存, 命中即回, 并触发后续分片预取
  if (isSeg) {
    fetchSegment(target).then(buf => {
      if (res.writableEnded || res.headersSent) return;
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': segMeta.get(target) || 'video/mp2t',
        'Content-Length': buf.length,
        'Accept-Ranges': 'none',
      });
      res.end(buf);
      prefetchAround(target);
    }).catch(e => json(res, 502, { error: e.message }));
    return;
  }

  // 其他资源(mp4 拖动/带 Range): 直通流式
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  upstream(target, headers, up => {
    const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': up.headers['content-type'] || 'application/octet-stream' };
    if (up.headers['content-length']) h['Content-Length'] = up.headers['content-length'];
    if (up.headers['content-range']) h['Content-Range'] = up.headers['content-range'];
    if (up.headers['accept-ranges']) h['Accept-Ranges'] = up.headers['accept-ranges'];
    res.writeHead(up.statusCode || 200, h);
    up.pipe(res);
    // 客户端断开(seek/切集/关页面)时释放上游连接
    res.on('close', () => up.destroy());
  }).on('error', e => {
    if (!res.headersSent) json(res, 502, { error: e.message });
    else res.destroy();
  });
}

/* ---------------- 路由 ---------------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  try {
    if (p === '/api/library') {
      return json(res, 200, { libs: loadLibraries() });
    }

    if (p === '/api/video') {
      const file = u.searchParams.get('file');
      const id = u.searchParams.get('id');
      const lib = loadLibraries().find(l => l.file === file);
      const v = lib && lib.videos.find(x => x.id === id);
      if (!v) return json(res, 404, { error: '影片不存在' });
      const h = loadHistory();
      const key = `${file}::${id}`;
      return json(res, 200, { video: v, progress: h.items[key] || null });
    }

    if (p === '/api/history' && req.method === 'GET') {
      const h = loadHistory();
      const list = Object.entries(h.items)
        .map(([key, it]) => ({ key, ...it }))
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      return json(res, 200, { items: list });
    }

    if (p === '/api/history' && req.method === 'POST') {
      const body = await readBody(req);
      const h = loadHistory();
      if (body.action === 'clear') {
        h.items = {};
      } else if (body.action === 'remove') {
        delete h.items[body.key];
      } else { // save
        const key = `${body.file}::${body.videoId}`;
        const prev = h.items[key] || {};
        h.items[key] = {
          file: body.file, videoId: body.videoId,
          name: body.name || prev.name || '', pic: body.pic || prev.pic || '',
          episodeIndex: body.episodeIndex ?? prev.episodeIndex ?? 0,
          episodeName: body.episodeName || prev.episodeName || '',
          position: body.position ?? prev.position ?? 0,
          duration: body.duration ?? prev.duration ?? 0,
          finished: !!body.finished,
          updatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
        };
      }
      saveHistory(h);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/cache/tasks' && req.method === 'GET') {
      const items = [...cacheTasks.values()]
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      return json(res, 200, { items });
    }

    if (p === '/api/cache/task' && req.method === 'POST') {
      const body = await readBody(req);
      const gi = body.groupIndex | 0, ei = body.episodeIndex | 0;
      const key = taskKey(body.file || '', body.videoId || '', gi, ei);
      if (body.action === 'start') {
        const lib = loadLibraries().find(l => l.file === body.file);
        const v = lib && lib.videos.find(x => x.id === body.videoId);
        const g = v && (v.groups || [])[gi];
        const ep = g && (g.episodes || [])[ei];
        if (!ep || !ep.url) return json(res, 404, { error: '未找到该分集' });
        const exist = cacheTasks.get(key);
        if (exist && (exist.status === 'queued' || exist.status === 'running')) {
          return json(res, 200, { task: exist }); // 已在队列/下载中: 不重复排队
        }
        const task = {
          key, file: body.file, videoId: body.videoId,
          name: v.name, pic: v.pic || '',
          groupIndex: gi, episodeIndex: ei,
          episodeName: ep.name, url: ep.url,
          status: 'queued', total: 0, done: 0, bytes: 0, sizeMB: 0, error: '',
          updatedAt: nowStr(),
        };
        cacheTasks.set(key, task);
        cacheQueue.push(key);
        persistCacheTasks();
        pumpCacheQueue();
        return json(res, 200, { task });
      }
      if (body.action === 'cancel') {
        const t = cacheTasks.get(key);
        if (t && (t.status === 'queued' || t.status === 'running')) {
          const qi = cacheQueue.indexOf(key);
          if (qi >= 0) cacheQueue.splice(qi, 1);
          t.status = 'canceled'; // 下载循环检测到后自动收尾
          t.updatedAt = nowStr();
          persistCacheTasks();
        }
        return json(res, 200, { ok: true });
      }
      if (body.action === 'remove') {
        const t = cacheTasks.get(key);
        if (t && (t.status === 'queued' || t.status === 'running')) {
          const qi = cacheQueue.indexOf(key);
          if (qi >= 0) cacheQueue.splice(qi, 1);
          t.status = 'canceled';
        }
        cacheTasks.delete(key);
        persistCacheTasks();
        return json(res, 200, { ok: true });
      }
      return json(res, 400, { error: 'bad action' });
    }

    if (p === '/api/cache') {
      return json(res, 200, {
        dir: CACHE_DIR,
        enabled: !diskDisabled,
        files: diskFiles.size,
        usedMB: Math.round(diskBytes / 1048576),
        maxMB: CACHE_MAX_BYTES ? Math.ceil(CACHE_MAX_BYTES / 1048576) : 0, // 0=不限
      });
    }

    if (p === '/proxy') {
      const target = u.searchParams.get('url');
      if (!target || !/^https?:\/\//.test(target)) return json(res, 400, { error: 'bad url' });
      return handleProxy(req, res, target);
    }

    if (req.method === 'GET') return serveStatic(res, p);
    res.writeHead(405); res.end();
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

/* ---------------- 全局异常兜底 ----------------
 * 本服务长期挂着供电视/手机播放, 不能静默退出。
 * 未捕获异常/Promise 拒绝: 记录到 data/crash.log 并保持存活(本地播放服务可接受的降级)。 */
function logCrash(kind, err) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${kind}: ${err && (err.stack || err.message || err)}\n`;
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.appendFileSync(path.join(DATA_DIR, 'crash.log'), line); } catch {}
  console.error(line);
}
process.on('uncaughtException', e => logCrash('uncaughtException', e));
process.on('unhandledRejection', e => logCrash('unhandledRejection', e));

/* ---------------- 启动 ---------------- */
migrateCacheDir();    // 上次缓存目录与本次不同: 把旧缓存 mv 到新目录
try {
  fs.mkdirSync(CACHE_SEG_DIR, { recursive: true });
} catch (e) {
  diskDisabled = true;
  console.error(`缓存目录创建失败(${e.message}), 磁盘缓存停用`);
}
initDiskCacheStats(); // 扫描已有缓存, 建立大小记账
loadCacheTasks();     // 载入手动缓存任务记录(重启前未完成的标记为中断)

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 被占用 — 可能已有一个服务在跑, 或被其他程序占用。`);
    console.error(`  换端口: PORT=9000 node server.js`);
    process.exit(1);
  }
  logCrash('server.error', e);
});

server.listen(PORT, HOST, () => {
  const urls = HOST === '0.0.0.0'
    ? [`http://127.0.0.1:${PORT}`, ...lanAddresses().map(ip => `http://${ip}:${PORT}`)]
    : [`http://${HOST}:${PORT}`];
  console.log('影视工具已启动:');
  urls.forEach(u => console.log(`  ${u}`));
  console.log(`磁盘缓存: ${CACHE_DIR} — ${diskFiles.size} 片 / ${Math.round(diskBytes / 1048576)}MB, 上限 ${CACHE_MAX_BYTES ? Math.ceil(CACHE_MAX_BYTES / 1048576) + 'MB' : '不限'}`);
  const libs = loadLibraries();
  console.log(`片库: ${libs.map(l => `${l.file}(${l.videos.length}部)`).join(', ') || '无 — 先运行 node crawl.js'}`);

  if (!process.env.NO_OPEN) {
    const url = urls[0];
    const cmd = process.platform === 'darwin' ? `open "${url}"`
      : process.platform === 'win32' ? `start "" "${url}"`
        : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
});
