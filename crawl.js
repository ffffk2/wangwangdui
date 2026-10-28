/**
 * crawl.js — 从暴风资源(maccms API)爬取影片信息, 写入配置文件
 *
 * 用法:
 *   node crawl.js                          # 默认爬 "汪汪队", 输出 resources/汪汪队/baofeng.json
 *   node crawl.js --kw=灌篮高手            # 爬其他关键词, 输出 resources/灌篮高手/baofeng.json
 *   node crawl.js --kw=汪汪队 --keep-all   # 保留[电影解说]/[预告片]等条目
 *   node crawl.js --out=resources/电影/x.json  # 指定输出文件
 *   node crawl.js --api=<其他maccms接口>   # 换采集源
 *
 * resources/ 目录支持多级子目录, server.js 会递归扫描所有 *.json 作为片库。
 *
 * 零依赖, 需要 Node >= 14。配置文件被 server.js 读取作为播放片库。
 */
'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

/* ---------- 参数 ---------- */
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] !== undefined ? m[2] : true] : [a, true];
  })
);
const KEYWORD = args.kw || '汪汪队';
const API = args.api || 'https://bfzyapi.com/api.php/provide/vod/';
const HOST_TAG = new URL(API).hostname.split('.')[0];
const SOURCE_NAME = args.name || ({ bfzyapi: 'baofeng' }[HOST_TAG] || HOST_TAG);
const SOURCE_LABEL = args.label || ({ baofeng: '暴风资源' }[SOURCE_NAME] || HOST_TAG);
const OUT = path.resolve(__dirname, args.out || path.join('resources', KEYWORD, `${SOURCE_NAME}.json`));
const KEEP_ALL = !!args['keep-all'];

const UA = 'okhttp/3.15';
const AGENT = new https.Agent({ rejectUnauthorized: false }); // 公司网络做了 TLS 劫持, 跳过证书校验

function fetchText(url) {
  const u = new URL(url);
  const mod = u.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = mod.get(
      url,
      { headers: { 'User-Agent': UA }, agent: u.protocol === 'https:' ? AGENT : undefined, timeout: 20000 },
      res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(fetchText(new URL(res.headers.location, url).href));
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} ${url}`));
        let buf = [];
        res.on('data', c => buf.push(c));
        res.on('end', () => resolve(Buffer.concat(buf).toString('utf8')));
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout ' + url)));
    req.on('error', reject);
  });
}

async function fetchJson(url) {
  const t = await fetchText(url);
  try {
    return JSON.parse(t);
  } catch (e) {
    throw new Error(`非 JSON 响应: ${t.slice(0, 120)}`);
  }
}

const api = (q) => API + (API.includes('?') ? '&' : '?') + q;

/* ---------- 分集解析 ---------- */
function parsePlayGroups(vod) {
  const from = String(vod.vod_play_from || '').split('$$$');
  const urls = String(vod.vod_play_url || '').split('$$$');
  const groups = [];
  for (let i = 0; i < urls.length; i++) {
    const eps = urls[i].split('#').filter(Boolean).map(item => {
      const [name, url] = item.split('$');
      return { name: (name || '').trim(), url: (url || '').trim() };
    }).filter(e => e.url);
    if (eps.length) groups.push({ from: (from[i] || 'm3u8').trim(), episodes: eps });
  }
  return groups;
}

/* ---------- 片名排序: 第一季~第十季在前, 特别篇次之, 大电影在后 ---------- */
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function parseCnNum(s) {
  if (!s) return 0;
  if (s === '十') return 10;
  const m = s.match(/^(.)十(.)?$/);
  if (m) return CN_NUM[m[1]] * 10 + (m[2] ? CN_NUM[m[2]] : 0);
  return CN_NUM[s] || 0;
}
function sortKey(name) {
  const n = String(name);
  let s = n.match(/第([一二三四五六七八九十]+)季/);
  if (s) return { rank: parseCnNum(s[1]), sub: 0 };
  if (/小砾与工程家族/.test(n)) { s = n.match(/第([一二三四五六七八九十]+)季/); return { rank: 100, sub: s ? parseCnNum(s[1]) : 0 }; }
  if (/海陆空/.test(n)) return { rank: 110, sub: 0 };
  if (/萌宠|番外/.test(n)) return { rank: 120, sub: 0 };
  if (/超能救援/.test(n)) return { rank: 130, sub: 0 };
  if (/勇敢大营救/.test(n)) return { rank: 140, sub: 0 };
  if (/大电影3/.test(n)) return { rank: 203, sub: 0 };
  if (/大电影2/.test(n)) return { rank: 202, sub: 0 };
  if (/大电影/.test(n)) return { rank: 201, sub: 0 };
  return { rank: 500, sub: 0 };
}

/* ---------- 主流程 ---------- */
async function main() {
  console.log(`[1/3] 搜索关键词 "${KEYWORD}" @ ${API}`);
  const all = [];
  let pg = 1;
  while (true) {
    const d = await fetchJson(api(`ac=videolist&wd=${encodeURIComponent(KEYWORD)}&pg=${pg}`));
    const list = d.list || [];
    all.push(...list);
    console.log(`  第 ${pg}/${d.pagecount || 1} 页, 本页 ${list.length} 条, 累计 ${all.length} 条`);
    if (!d.pagecount || pg >= +d.pagecount) break;
    pg++;
  }

  let vods = all.filter(v => String(v.vod_name || '').includes(KEYWORD));
  if (!KEEP_ALL) {
    const dropped = vods.filter(v => /解说|预告片|预告/.test(v.vod_name));
    if (dropped.length) console.log(`  过滤掉 解说/预告片 ${dropped.length} 条: ${dropped.map(v => v.vod_name).join(' / ')}`);
    vods = vods.filter(v => !/解说|预告片|预告/.test(v.vod_name));
  }

  console.log(`[2/3] 逐条拉取详情, 共 ${vods.length} 部`);
  const videos = [];
  for (let i = 0; i < vods.length; i++) {
    const brief = vods[i];
    try {
      const d = await fetchJson(api(`ac=videolist&ids=${brief.vod_id}`));
      const v = (d.list || [])[0] || brief;
      const groups = parsePlayGroups(v);
      videos.push({
        id: String(v.vod_id),
        name: v.vod_name,
        type: v.type_name || '',
        year: String(v.vod_year || ''),
        area: v.vod_area || '',
        lang: v.vod_lang || '',
        actor: v.vod_actor || '',
        director: v.vod_director || '',
        score: v.vod_score || '',
        remark: v.vod_remark || '',
        pic: v.vod_pic || '',
        content: (v.vod_content || '').replace(/<[^>]+>/g, '').trim(),
        updated: v.vod_time || '',
        apiUpdated: v.vod_time,
        groups,
        episodeCount: groups.reduce((n, g) => n + g.episodes.length, 0),
      });
      console.log(`  (${i + 1}/${vods.length}) ${v.vod_name} 共 ${videos[videos.length - 1].episodeCount} 集`);
    } catch (e) {
      console.log(`  (${i + 1}/${vods.length}) 失败: ${brief.vod_name} :: ${e.message}`);
    }
  }

  videos.sort((a, b) => {
    const ka = sortKey(a.name), kb = sortKey(b.name);
    return ka.rank - kb.rank || ka.sub - kb.sub || a.name.localeCompare(b.name, 'zh');
  });

  const conf = {
    source: {
      name: SOURCE_LABEL,
      api: API,
      keyword: KEYWORD,
      crawledAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      count: videos.length,
      totalEpisodes: videos.reduce((n, v) => n + v.episodeCount, 0),
    },
    videos,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(conf, null, 1), 'utf8');
  console.log(`[3/3] 已写入 ${OUT}`);
  console.log(`  共 ${videos.length} 部 / ${conf.source.totalEpisodes} 集`);
}

main().catch(e => {
  console.error('爬取失败:', e.message);
  process.exit(1);
});
