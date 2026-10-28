/* app.js — 影视工具前端(原生JS, 无框架) */
'use strict';

const $ = sel => document.querySelector(sel);
const view = $('#view');

const state = {
  libs: [], videos: [], q: '',
  video: null, progress: null, epIndex: 0,
  autoplay: true,
  hls: null, saveTimer: 0, resumeAt: 0,
  countdown: null,
};

const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="100%" height="100%" fill="#1d2230"/><text x="50%" y="50%" fill="#5a6377" font-size="20" text-anchor="middle" dominant-baseline="middle">无海报</text></svg>`
);

/* ---------------- 工具 ---------------- */
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), ms);
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || r.status);
  return d;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function saveProgress(patch) {
  if (!state.video) return;
  const v = state.video;
  const ep = v.groups[0].episodes[state.epIndex];
  return api('/api/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'save',
      file: v.lib, videoId: v.id, name: v.name, pic: v.pic,
      episodeIndex: state.epIndex, episodeName: ep.name,
      position: patch.position ?? 0, duration: patch.duration ?? 0,
      finished: !!patch.finished,
    }),
  }).catch(e => console.warn('保存进度失败', e));
}

/* ---------------- hls.js 加载 ---------------- */
function loadHls() {
  return new Promise((resolve, reject) => {
    if (window.Hls) return resolve(window.Hls);
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js';
    s.onload = () => window.Hls ? resolve(window.Hls) : reject(new Error('hls.js 加载失败'));
    s.onerror = () => reject(new Error('hls.js 加载失败(检查网络)'));
    document.head.appendChild(s);
  });
}

/* ---------------- 视图切换 ---------------- */
function destroyPlayer() {
  cancelCountdown();
  if (state.hls) { state.hls.destroy(); state.hls = null; }
}

function setTab(name) {
  $('#tab-library').classList.toggle('active', name === 'library');
  $('#tab-history').classList.toggle('active', name === 'history');
}

function onSearch(q) {
  state.q = q.trim();
  if (state.video && state.q) return; // 播放中不切换视图
  if (!state.q) return renderCurrent();
  renderLibrary();
}

function renderCurrent() {
  if (state.video) renderPlayer();
  else showLibrary();
}

/* ---------------- 片库 ---------------- */
async function showLibrary() {
  setTab('library');
  destroyPlayer();
  state.video = null; state.q = '';
  $('#search').value = '';
  view.innerHTML = '<div class="empty">加载中…</div>';
  try {
    const d = await api('/api/library');
    state.libs = d.libs;
    state.videos = d.libs.flatMap(l => l.videos);
  } catch (e) {
    return view.innerHTML = `<div class="empty">片库加载失败: ${esc(e.message)}</div>`;
  }
  renderLibrary();
}

function renderLibrary() {
  setTab('library');
  const kw = state.q.toLowerCase();
  const vids = kw
    ? state.videos.filter(v => (v.name + v.type + v.year + v.actor).toLowerCase().includes(kw))
    : state.videos;

  if (!state.videos.length) {
    view.innerHTML = `<div class="empty">片库为空。<br>先运行爬虫生成资源:<br><code>node crawl.js</code></div>`;
    return;
  }
  if (!vids.length) {
    view.innerHTML = `<div class="empty">没有匹配 "${esc(state.q)}" 的影片</div>`;
    return;
  }

  // 按目录分组(多目录结构)
  const groups = {};
  for (const v of vids) {
    const dir = (v.lib || '').split('/')[0] || '默认';
    (groups[dir] = groups[dir] || []).push(v);
  }

  let html = '';
  for (const [dir, list] of Object.entries(groups)) {
    html += `<div class="group-title">📁 ${esc(dir)} · ${list.length} 部</div><div class="grid">`;
    for (const v of list) {
      html += `
        <div class="card" onclick="openDetail('${esc(v.lib)}','${esc(v.id)}')">
          <img class="poster" src="${esc(v.pic) || PLACEHOLDER}" onerror="this.src='${PLACEHOLDER}'" loading="lazy">
          <div class="info">
            <div class="name">${esc(v.name)}</div>
            <div class="meta"><span>${esc(v.year || v.type || '')}</span><span>${v.episodeCount}集</span></div>
          </div>
        </div>`;
    }
    html += `</div>`;
  }
  view.innerHTML = html;
}

/* ---------------- 详情 ---------------- */
async function openDetail(lib, id, opts = {}) {
  destroyPlayer();
  view.innerHTML = '<div class="empty">加载中…</div>';
  try {
    const d = await api(`/api/video?file=${encodeURIComponent(lib)}&id=${encodeURIComponent(id)}`);
    state.video = d.video;
    state.progress = d.progress;
  } catch (e) {
    return view.innerHTML = `<div class="empty">加载失败: ${esc(e.message)}</div>`;
  }
  setTab('library');
  renderDetail(opts);
}

function renderDetail(opts = {}) {
  const v = state.video;
  const g = v.groups[0];
  const watched = new Set(
    state.progress ? [state.progress.episodeIndex] : []
  );
  const meta = [
    v.year && `年份 ${v.year}`, v.type, v.area, v.lang,
    v.remark && `备注 ${v.remark}`, v.episodeCount + ' 集',
    v.score && `评分 ${v.score}`,
  ].filter(Boolean).map(x => `<span class="badge">${esc(x)}</span>`).join('');
  const extra = [
    v.director && `导演: ${esc(v.director)}`,
    v.actor && `主演: ${esc(v.actor)}`,
    v.updated && `资源更新: ${esc(v.updated)}`,
  ].filter(Boolean).map(x => `<div class="badge">${x}</div>`).join('');

  view.innerHTML = `
    <button class="btn back" onclick="showLibrary()">← 返回片库</button>
    <div class="detail">
      <img class="poster" src="${esc(v.pic) || PLACEHOLDER}" onerror="this.src='${PLACEHOLDER}'">
      <div class="meta">
        <h2>${esc(v.name)}</h2>
        <div>${meta}</div>
        ${v.content ? `<div class="desc">${esc(v.content).slice(0, 500)}</div>` : ''}
        <div>${extra}</div>
        ${state.progress && !state.progress.finished
          ? `<button class="btn primary" style="margin-top:10px" onclick="openPlayer(${state.progress.episodeIndex}, true)">▶ 续播 ${esc(state.progress.episodeName)} (${fmtDur(state.progress.position)})</button>`
          : ''}
        <div class="ep-grid">
          ${g.episodes.map((e, i) => `
            <button class="ep-btn ${watched.has(i) ? 'watched' : ''}"
                    onclick="openPlayer(${i})" title="${esc(e.url)}">${esc(e.name)}</button>`).join('')}
        </div>
      </div>
    </div>`;
  window.scrollTo(0, 0);
  if (opts.autoPlay && state.progress) openPlayer(state.progress.episodeIndex, true);
}

function fmtDur(sec) {
  if (!sec || sec < 60) return '继续观看';
  const m = Math.floor(sec / 60);
  return `看到 ${m} 分钟`;
}

/* ---------------- 播放 ---------------- */
async function openPlayer(epIndex, resume) {
  const v = state.video;
  if (!v) return;
  state.epIndex = epIndex;
  state.resumeAt = resume && state.progress && state.progress.episodeIndex === epIndex ? (state.progress.position || 0) : 0;
  const g = v.groups[0];
  const ep = g.episodes[epIndex];

  const total = g.episodes.length;
  const sideEps = g.episodes.map((e, i) =>
    `<button class="ep-btn ${i === epIndex ? 'current' : ''}" onclick="switchEp(${i})">${esc(e.name)}</button>`).join('');

  view.innerHTML = `
    <div class="player-layout">
      <div class="player-main">
        <video id="video" controls autoplay playsinline></video>
        <div class="player-title">${esc(v.name)} · ${esc(ep.name)}</div>
        <div class="player-sub">来源 ${esc(v.groups[0].from)} | 共 ${total} 集 | ${resume ? '尝试续播…' : ''}</div>
        <div class="player-ctrl">
          <button class="btn" onclick="switchEp(${epIndex - 1})" ${epIndex <= 0 ? 'disabled' : ''}>上一集</button>
          <button class="btn primary" onclick="switchEp(${epIndex + 1})" ${epIndex >= total - 1 ? 'disabled' : ''}>下一集</button>
          <label><input type="checkbox" id="autoplay" ${state.autoplay ? 'checked' : ''} onchange="state.autoplay=this.checked"> 播完自动下一集</label>
          <button class="btn" onclick="openDetail('${esc(v.lib)}','${esc(v.id)}')">返回详情</button>
        </div>
      </div>
      <div class="ep-side">
        <div class="list">${sideEps}</div>
      </div>
    </div>`;
  window.scrollTo(0, 0);

  const video = $('#video');
  bindPlayer(video, ep.url);
}

function bindPlayer(video, rawUrl) {
  const src = '/proxy?url=' + encodeURIComponent(rawUrl);

  if (state.hls) { state.hls.destroy(); state.hls = null; }
  video.onerror = null;

  const nativeHls = video.canPlayType('application/vnd.apple.mpegurl');
  const hlsConf = { maxBufferLength: 60, backBufferLength: 30 };
  if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls(hlsConf);
    state.hls = hls;
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.ERROR, (_, data) => {
      if (data.fatal) toast(`播放出错: ${data.details}`, 4000);
    });
  } else if (nativeHls) {
    video.src = src;
  } else {
    loadHls().then(H => {
      const hls = new H(hlsConf);
      state.hls = hls;
      hls.loadSource(src);
      hls.attachMedia(video);
    }).catch(e => toast(e.message, 4000));
  }

  video.onloadedmetadata = () => {
    if (state.resumeAt > 30 && video.duration - state.resumeAt > 60) {
      video.currentTime = state.resumeAt;
      toast(`已从 ${Math.floor(state.resumeAt / 60)} 分钟处续播`);
    }
  };

  video.ontimeupdate = () => {
    const now = Date.now();
    if (now - state.saveTimer > 5000 && video.currentTime > 5) {
      state.saveTimer = now;
      saveProgress({ position: video.currentTime, duration: video.duration || 0 });
    }
  };

  video.onended = () => {
    const v = state.video, g = v.groups[0];
    saveProgress({ position: 0, duration: video.duration || 0, finished: true });
    const next = state.epIndex + 1;
    if (state.autoplay && next < g.episodes.length) {
      showCountdown(next);
    } else if (next >= g.episodes.length) {
      toast('本片已播完 🎉');
    }
  };

  video.onerror = () => toast('视频加载失败, 可尝试切换其他分集或稍后重试', 4000);
}

function switchEp(i) {
  const g = state.video.groups[0];
  if (i < 0 || i >= g.episodes.length) return;
  cancelCountdown();
  openPlayer(i, false);
  saveProgress({ position: 0, duration: 0 }).then(() => {});
}

/* ---------------- 连播倒计时 ---------------- */
function showCountdown(nextIndex) {
  cancelCountdown();
  const g = state.video.groups[0];
  const ep = g.episodes[nextIndex];
  let left = 5;
  const div = document.createElement('div');
  div.className = 'overlay';
  div.id = 'next-overlay';
  div.innerHTML = `
    <div class="box">
      <h3>即将自动播放</h3>
      <p>${esc(ep.name)} · <b id="cd">${left}</b> 秒</p>
      <button class="btn primary" onclick="cancelCountdown();openPlayer(${nextIndex},false)">立即播放</button>
      <button class="btn" onclick="cancelCountdown()">取消连播</button>
    </div>`;
  document.body.appendChild(div);
  state.countdown = setInterval(() => {
    left--;
    const el = $('#cd');
    if (el) el.textContent = left;
    if (left <= 0) {
      cancelCountdown();
      openPlayer(nextIndex, false);
    }
  }, 1000);
}

function cancelCountdown() {
  if (state.countdown) { clearInterval(state.countdown); state.countdown = null; }
  const o = $('#next-overlay');
  if (o) o.remove();
}

/* ---------------- 历史 ---------------- */
async function showHistory() {
  setTab('history');
  if (document.querySelector('video#video')) return toast('播放中无法查看历史, 请先返回');
  view.innerHTML = '<div class="empty">加载中…</div>';
  try {
    const d = await api('/api/history');
    renderHistory(d.items);
  } catch (e) {
    view.innerHTML = `<div class="empty">加载失败: ${esc(e.message)}</div>`;
  }
}

function renderHistory(items) {
  if (!items.length) {
    view.innerHTML = `<div class="empty">还没有观看记录<br>去片库挑一部片吧~</div>`;
    return;
  }
  view.innerHTML = `
    <button class="btn back" onclick="if(confirm('确定清空全部历史?'))clearHistory()">清空历史</button>
    ${items.map(it => {
      const pct = it.duration ? Math.min(100, Math.round(it.position / it.duration * 100)) : 0;
      return `
      <div class="hist-item">
        <img src="${esc(it.pic) || PLACEHOLDER}" onerror="this.src='${PLACEHOLDER}'">
        <div class="h-info">
          <div class="h-name">${esc(it.name)}</div>
          <div class="h-ep">${esc(it.episodeName)}
            ${it.finished ? '<span class="hist-done">· 已看完本集</span>' : ` · ${Math.floor(it.position / 60)}分 / ${Math.floor((it.duration || 0) / 60)}分`}
            &nbsp;·&nbsp;${esc(it.updatedAt || '')}
          </div>
          <div class="progress"><i style="width:${pct}%"></i></div>
        </div>
        <div class="h-actions">
          <button class="btn primary" onclick="resumeHistory('${esc(it.key)}')">▶ 继续播放</button>
          <button class="btn" onclick="removeHistory('${esc(it.key)}')">删除</button>
        </div>
      </div>`;
    }).join('')}`;
}

async function resumeHistory(key) {
  const d = await api('/api/history');
  const it = d.items.find(x => x.key === key);
  if (!it) return toast('记录不存在');
  await openDetail(it.file, it.videoId, { autoPlay: true });
}

async function removeHistory(key) {
  await api('/api/history', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'remove', key }),
  });
  showHistory();
}

async function clearHistory() {
  await api('/api/history', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'clear' }),
  });
  showHistory();
}

/* ---------------- 启动 ---------------- */
showLibrary();
