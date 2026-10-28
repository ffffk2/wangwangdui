/**
 * server.js — 本地影视播放服务(零依赖, BS 架构, 跨平台 win/mac/linux)
 *
 * 用法:
 *   node server.js                       # 默认 http://<LAN_IP>:8686
 *   PORT=9000 node server.js             # 自定义端口
 *   HOST=127.0.0.1 node server.js        # 仅本机访问
 *   NO_OPEN=1 node server.js             # 不自动打开浏览器
 *
 * 资源结构(多目录, 递归扫描):
 *   resources/<任意子目录>/<片库>.json    # crawl.js 生成; 新增文件刷新页面即生效
 *
 * 接口:
 *   GET  /api/library                    片库(递归合并 resources 下全部 .json)
 *   GET  /api/video?file=&id=            影片详情+分集+观看进度
 *   GET  /api/history                    观看历史
 *   POST /api/history                    {action:'save'|'remove'|'clear',...}
 *   GET  /proxy?url=                     m3u8/ts 反向代理(解决跨域/防盗链)
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');
const { URL } = require('url');

const PORT = +process.env.PORT || 8686;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const RES_DIR = path.join(__dirname, 'resources');
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

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

function fetchSegment(url) {
  if (segCache.has(url)) return Promise.resolve(segCache.get(url));
  if (segInflight.has(url)) return segInflight.get(url);
  const p = new Promise((resolve, reject) => {
    upstream(url, null, up => {
      const chunks = [];
      up.on('data', c => chunks.push(c));
      up.on('end', () => {
        const buf = Buffer.concat(chunks);
        cachePut(url, buf, up.headers['content-type']);
        resolve(buf);
      });
      up.on('error', reject);
    }).on('error', reject);
  }).then(
    buf => { segInflight.delete(url); return buf; },
    e => { segInflight.delete(url); throw e; }
  );
  segInflight.set(url, p);
  return p;
}

function prefetchAround(segUrl) {
  const pos = segIndex.get(segUrl);
  if (!pos) return;
  const list = segOrder.get(pos.pl);
  if (!list) return;
  for (let k = pos.i + 1; k <= Math.min(pos.i + PREFETCH_AHEAD, list.length - 1); k++) {
    if (!segCache.has(list[k]) && !segInflight.has(list[k])) {
      fetchSegment(list[k]).catch(() => {});
    }
  }
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

/* ---------------- 启动 ---------------- */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  const urls = HOST === '0.0.0.0'
    ? [`http://127.0.0.1:${PORT}`, ...lanAddresses().map(ip => `http://${ip}:${PORT}`)]
    : [`http://${HOST}:${PORT}`];
  console.log('影视工具已启动:');
  urls.forEach(u => console.log(`  ${u}`));
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
