/* 临时验证脚本: 走 /api/video + /proxy 链路, 检查 5 部小猪佩奇的 m3u8 与分片可用性 */
'use strict';
const https = require('https');
const http = require('http');
const AGENT = new https.Agent({ rejectUnauthorized: false });

function fetchBin(url, timeout = 30000) {
  const u = new URL(url);
  const mod = u.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { headers: { 'User-Agent': 'okhttp/3.15' }, agent: u.protocol === 'https:' ? AGENT : undefined, timeout }, res => {
      const buf = [];
      res.on('data', c => buf.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(buf) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function main() {
  const base = 'http://127.0.0.1:8686';
  const lib = await (async () => JSON.parse((await fetchBin(base + '/api/library')).body.toString('utf8')))();
  const file = lib.libs.find(l => l.file.includes('小猪佩奇')).file;
  const detail = JSON.parse((await fetchBin(base + `/api/video?file=${encodeURIComponent(file)}&id=${lib.libs.find(l => l.file.includes('小猪佩奇')).videos[0].id}`)).body.toString('utf8'));
  // 取所有影片
  for (const v of lib.libs.find(l => l.file.includes('小猪佩奇')).videos) {
    const d = JSON.parse((await fetchBin(base + `/api/video?file=${encodeURIComponent(file)}&id=${v.id}`)).body.toString('utf8'));
    const g = d.video.groups[0];
    const ep = g.episodes[0];
    console.log(`\n=== ${d.video.name} (${v.episodeCount || g.episodes.length}集, 来自${g.from}) ===`);
    console.log(`  集名: ${ep.name}`);
    // 1. 经代理拉 m3u8 (ep.url 为上游原始地址, 前端播放时由 wrapProxy 包装, 这里同样包装)
    const wrapped = '/proxy?url=' + encodeURIComponent(ep.url);
    let m3u8;
    try {
      const r = await fetchBin(base + wrapped);
      m3u8 = r.body.toString('utf8');
      const isM3u8 = /#EXTM3U/.test(m3u8);
      const proxied = (m3u8.match(/\/proxy\?url=/g) || []).length;
      console.log(`  m3u8: HTTP ${r.status} ${r.headers['content-type'] || ''} | EXTM3U=${isM3u8} | 重写分片数=${proxied} | 原文长度=${m3u8.length}`);
      if (!isM3u8) { console.log(`  ⚠ 非 m3u8 内容: ${m3u8.slice(0, 150)}`); continue; }
      if (m3u8.includes('#EXT-X-STREAM-INF')) {
        // 主播放列表, 取第一个子 m3u8 再拉
        const sub = m3u8.split('\n').find(l => l.trim() && !l.startsWith('#'));
        console.log(`  主列表 → 子列表: ${decodeURIComponent(sub.replace('/proxy?url=', '')).slice(0, 80)}`);
        const r2 = await fetchBin(base + sub.trim());
        m3u8 = r2.body.toString('utf8');
        console.log(`  子 m3u8: HTTP ${r2.status} | EXTM3U=${/#EXTM3U/.test(m3u8)} | 重写分片数=${(m3u8.match(/\/proxy\?url=/g) || []).length}`);
      }
      // 2. 经代理拉第一个分片
      const seg = m3u8.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
      if (!seg) { console.log('  ⚠ 找不到分片行'); continue; }
      const t0 = Date.now();
      const rs = await fetchBin(base + seg, 60000);
      const ms = Date.now() - t0;
      const kb = (rs.body.length / 1024).toFixed(1);
      const ok = rs.status === 200 && rs.body.length > 10240;
      console.log(`  分片: HTTP ${rs.status} | ${rs.headers['content-type'] || '?'} | ${kb}KB | ${ms}ms ${ok ? '✓' : '⚠ 太小或失败'}`);
      // 3. 第二个分片确认连续可用
      const segs = m3u8.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      if (segs[1]) {
        const r2 = await fetchBin(base + segs[1], 60000);
        console.log(`  分片2: HTTP ${r2.status} | ${(r2.body.length / 1024).toFixed(1)}KB`);
      }
    } catch (e) {
      console.log(`  ✗ 失败: ${e.message}`);
    }
  }
}
main().catch(e => { console.error('测试失败:', e); process.exit(1); });
