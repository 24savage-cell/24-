/* ============================================================
   野性档案 SAVAGE ARCHIVE · app.js
   双模存储：jsonblob 云端索引（跨设备共享）+ 本地 localStorage 兜底
   ============================================================ */
'use strict';

/* ---------- 常量 ---------- */
const BLOB_API = 'https://jsonblob.com/api/jsonBlob';
const LS = {
  gid: 'sa_gid', me: 'sa_me', likes: 'sa_likes',
  lidx: 'sa_local_index', lart: 'sa_local_art_'
};
const CLOUD_MAX_ARTS = 36;   // 云端索引最多保留的投稿（防止超出单 blob 体积限制）
const LOCAL_MAX_ARTS = 8;    // 本地模式最多保留的投稿（localStorage 约 5MB）
const RESERVED_NAMES = ['24.savage', '24savage', 'savage', 'admin', 'curator', 'system', 'anonymous', '匿名观众'];

/* ---------- 工具 ---------- */
const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const pad3 = n => String(n).padStart(3, '0');
const b64bytes = s => Math.floor(s.length * 0.75);
const fmtTs = ts => {
  const d = new Date(ts);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

function toast(msg, isErr = false, ms = 3200) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, ms);
}

async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
/* 兼容旧版会话：sa_me 若为纯字符串（旧昵称），转为对象结构 */
(function migrateSession() {
  const raw = localStorage.getItem(LS.me);
  if (raw && !raw.startsWith('{')) {
    try { localStorage.setItem(LS.me, JSON.stringify({ n: raw })); } catch { }
  }
})();

/* ---------- 云端 API（jsonblob） ---------- */
const cloud = {
  async create(obj) {
    const r = await withTimeout(fetch(BLOB_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(obj)
    }), 15000);
    if (!r.ok) throw new Error('cloud create ' + r.status);
    const loc = r.headers.get('Location') || r.headers.get('X-jsonblob-id') || '';
    const m = String(loc).match(/(\d{8,})/);
    if (!m) throw new Error('cloud create: no id');
    return m[1];
  },
  async get(id) {
    const r = await withTimeout(fetch(`${BLOB_API}/${id}`, {
      headers: { 'Accept': 'application/json' }, cache: 'no-store'
    }), 12000);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('cloud get ' + r.status);
    return r.json();
  },
  async put(id, obj) {
    const r = await withTimeout(fetch(`${BLOB_API}/${id}?t=${Date.now()}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(obj)
    }), 15000);
    if (!r.ok) throw new Error('cloud put ' + r.status);
    return true;
  }
};

/* ---------- 状态 ---------- */
const S = {
  mode: 'pending',        // 'cloud' | 'local' | 'pending'（尚未创建云端索引）
  gid: localStorage.getItem(LS.gid) || '',
  cloudIndex: null,       // {v, seq, arts:[], users:[]}
  localIndex: null,
  seeds: [],
  session: (() => { try { return JSON.parse(localStorage.getItem(LS.me) || 'null'); } catch { return null; } })(),
  sort: 'new',
  filter: 'all',
  lbList: [], lbPos: -1,
  fullCache: new Map(),   // id -> 原图 dataURL
  pendingFile: null,
  authMode: 'reg'
};

const freshIndex = () => ({ v: 1, seq: 6, arts: [], users: [] }); // seq 从 6 起：001–006 为馆藏编号
const sanitizeIndex = idx => ({
  v: 1,
  seq: Number(idx && idx.seq) || 0,
  arts: Array.isArray(idx && idx.arts) ? idx.arts.filter(a => a && a.id) : [],
  users: Array.isArray(idx && idx.users) ? idx.users.filter(u => u && u.u) : []
});
const loadLocalIndex = () => {
  try { return sanitizeIndex(JSON.parse(localStorage.getItem(LS.lidx) || 'null')); }
  catch { return freshIndex(); }
};
const saveLocalIndex = idx => {
  try { localStorage.setItem(LS.lidx, JSON.stringify(idx)); }
  catch { // 配额不足：裁掉最老的
    idx.arts = idx.arts.slice(-Math.floor(LOCAL_MAX_ARTS / 2));
    try { localStorage.setItem(LS.lidx, JSON.stringify(idx)); } catch { }
  }
};

/* ---------- 初始化 ---------- */
async function init() {
  bindUI();
  bindKeys();
  await loadSeeds();
  renderSession();
  await initStore();
  renderAll();
  initTicker();
  const boot = $('#boot');
  setTimeout(() => boot.classList.add('done'), 1000);
  setTimeout(() => boot.classList.add('done'), 2600); // 兜底
}

function adoptHash() {
  const m = location.hash.match(/g=(\d{8,})/);
  if (m && m[1] && m[1] !== S.gid) {
    S.gid = m[1];
    localStorage.setItem(LS.gid, S.gid);
    toast('已连接到分享的云端展厅');
  }
}

async function initStore() {
  adoptHash();
  S.localIndex = loadLocalIndex();
  if (S.gid) {
    try {
      const idx = await cloud.get(S.gid);
      if (idx === null) { // blob 已被删除，重置
        S.gid = ''; localStorage.removeItem(LS.gid);
        S.cloudIndex = freshIndex(); S.mode = 'pending';
      } else {
        S.cloudIndex = sanitizeIndex(idx);
        S.mode = 'cloud';
      }
    } catch (e) {
      console.warn('cloud unreachable:', e);
      S.cloudIndex = freshIndex();
      S.mode = 'local';
      toast('云端暂时不可达，展厅以本地模式运行', true, 4200);
    }
  } else {
    S.cloudIndex = freshIndex();
    S.mode = 'pending';
  }
  setStatus();
}

async function loadSeeds() {
  try {
    const r = await fetch('works.json', { cache: 'force-cache' });
    const data = await r.json();
    S.seeds = (data.arts || []).map(a => ({ ...a, seed: true, likes: Number(a.likes) || 0 }));
  } catch { S.seeds = []; }
}

/* ---------- 状态徽标 ---------- */
function setStatus() {
  const chip = $('#statusChip');
  chip.classList.remove('chip-init', 'chip-ready', 'chip-local');
  if (S.mode === 'cloud') {
    chip.classList.add('chip-ready');
    chip.textContent = '● 云端同步中';
  } else if (S.mode === 'local') {
    chip.classList.add('chip-local');
    chip.textContent = '● 本地模式';
  } else {
    chip.classList.add('chip-init');
    chip.textContent = '● 云端待激活';
  }
}

/* ---------- 数据合并与渲染 ---------- */
function currentArts() {
  const map = new Map();
  for (const a of S.seeds) map.set(a.id, { ...a, store: 'seed' });
  for (const a of (S.cloudIndex ? S.cloudIndex.arts : [])) map.set(a.id, { ...a, store: 'cloud' });
  for (const a of (S.localIndex ? S.localIndex.arts : [])) if (!map.has(a.id)) map.set(a.id, { ...a, store: 'local' });
  return [...map.values()];
}

function applyLikes(arts) {
  let likes = {};
  try { likes = JSON.parse(localStorage.getItem(LS.likes) || '{}'); } catch { }
  return arts.map(a => ({ ...a, liked: !!likes[a.id] }));
}

function renderAll(newId) {
  let arr = applyLikes(currentArts());
  if (S.filter === 'seed') arr = arr.filter(a => a.seed);
  else if (S.filter === 'guest') arr = arr.filter(a => !a.seed);
  arr.sort(S.sort === 'hot'
    ? (a, b) => (b.likes || 0) - (a.likes || 0) || (b.ts || 0) - (a.ts || 0)
    : (a, b) => (b.ts || 0) - (a.ts || 0));
  S.lbList = arr;

  const grid = $('#grid');
  grid.innerHTML = '';
  arr.forEach((a, i) => grid.appendChild(plateEl(a, i, a.id === newId)));
  $('#skeletons').hidden = true;
  $('#emptyState').hidden = arr.length > 0;

  const contributors = new Set(arr.map(a => a.by || '匿名观众')).size;
  $('#hallCount').textContent = `N=${arr.length} · 投稿者 ${contributors} 人`;
  updateTicker();
  observeImgs();
}

function plateEl(a, i, isNew) {
  const el = document.createElement('article');
  el.className = 'plate' + (isNew ? ' is-new' : '');
  el.style.animationDelay = Math.min(i * 55, 440) + 'ms';
  const thumb = a.seed ? a.thumb : a.thumb;
  el.innerHTML = `
    <div class="plate-imgwrap">
      <span class="plate-no">Nº ${esc(a.no || pad3(i + 1))}</span>
      ${a.seed ? '<span class="plate-seedtag">馆藏</span>' : '<span class="plate-seedtag plate-seedtag-data">投稿</span>'}
      <img data-src="${thumb || ''}" alt="${esc(a.title)}" loading="lazy">
    </div>
    <div class="plate-meta">
      <h3 class="plate-title">${esc(a.title)}</h3>
      <div class="plate-sub">
        <span class="plate-by">${esc(a.by || '匿名观众')}</span>
        <button class="plate-like${a.liked ? ' liked' : ''}" type="button" aria-label="喜欢">♥ <span>${a.likes || 0}</span></button>
      </div>
    </div>`;
  el.addEventListener('click', () => openLb(i));
  $('.plate-like', el).addEventListener('click', e => { e.stopPropagation(); toggleLike(a.id); });
  return el;
}

let io = null;
function observeImgs() {
  if (io) io.disconnect();
  io = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (en.isIntersecting) {
        const img = en.target;
        if (img.dataset.src) { img.src = img.dataset.src; delete img.dataset.src; }
        io.unobserve(img);
      }
    }
  }, { rootMargin: '400px' });
  $$('#grid img').forEach(img => io.observe(img));
}

/* ---------- 走马灯 ---------- */
let tickerBase = '';
function updateTicker() {
  if (!tickerBase) return;
  $('#tickerTrack').innerHTML = tickerBase.repeat(2);
}
function initTicker() {
  const items = [
    '野性档案 SAVAGE ARCHIVE', 'BY 24.SAVAGE', 'EST. 2026',
    '观众投稿通道开放 OPEN SUBMISSION', 'FREE ENTRY · 自由入场', 'ALL WILD THINGS ARCHIVED'
  ];
  const seg = () => items.map(t => `<span>${t}</span>`).join('<b>◆</b>');
  tickerBase = seg();
  updateTicker();
}

/* ---------- 灯箱 ---------- */
let lbToken = 0;
async function openLb(pos) {
  const a = S.lbList[pos];
  if (!a) return;
  S.lbPos = pos;
  const token = ++lbToken;
  $('#lbNo').textContent = 'Nº ' + (a.no || pad3(pos + 1));
  $('#lbTitle').textContent = a.title;
  $('#lbEn').textContent = a.en || (a.seed ? 'CURATED COLLECTION' : 'GUEST SUBMISSION');
  $('#lbDesc').textContent = a.desc || '（作者未留下自述）';
  $('#lbBy').textContent = a.by || '匿名观众';
  $('#lbTs').textContent = fmtTs(a.ts || Date.now());
  $('#lbSrc').textContent = a.seed ? '馆藏精选 · CURATED' : (a.store === 'cloud' ? '观众投稿 · 云端档案' : '观众投稿 · 本机档案');
  updateLbLike(a);
  const lb = $('#lightbox');
  lb.hidden = false;
  document.body.style.overflow = 'hidden';

  const img = $('#lbImg'), load = $('#lbLoad');
  img.removeAttribute('src');
  load.hidden = false;
  let src = '';
  try {
    if (a.src) src = a.src;
    else if (a.store === 'local') {
      const raw = localStorage.getItem(LS.lart + a.id);
      src = raw ? (JSON.parse(raw).img || '') : '';
    } else if (S.fullCache.has(a.id)) src = S.fullCache.get(a.id);
    else if (a.bid) {
      const blob = await cloud.get(a.bid);
      src = (blob && blob.img) || '';
      S.fullCache.set(a.id, src);
    }
  } catch { toast('原图加载失败，稍后再试', true); }
  if (token !== lbToken) return; // 已切到下一件，丢弃过期结果
  img.onload = () => { load.hidden = true; };
  img.onerror = () => { load.hidden = true; };
  if (src) img.src = src; else { load.hidden = true; }
}
function closeLb() {
  $('#lightbox').hidden = true;
  document.body.style.overflow = '';
}
function updateLbLike(a) {
  const btn = $('#lbLike');
  btn.classList.toggle('liked', !!a.liked);
  $('#lbLikeN').textContent = a.likes || 0;
}

/* ---------- 点赞 ---------- */
async function toggleLike(id) {
  let likes = {};
  try { likes = JSON.parse(localStorage.getItem(LS.likes) || '{}'); } catch { }
  const all = applyLikes(currentArts());
  const a = all.find(x => x.id === id);
  if (!a) return;
  if (likes[id]) { delete likes[id]; a.likes = Math.max(0, (a.likes || 0) - 1); a.liked = false; }
  else { likes[id] = 1; a.likes = (a.likes || 0) + 1; a.liked = true; }
  localStorage.setItem(LS.likes, JSON.stringify(likes));

  // 同步计数到对应存储（失败不影响本机体验）
  if (!a.seed) {
    try {
      if (a.store === 'cloud' && S.mode !== 'local') {
        await mergePutCloud(idx => {
          const t = idx.arts.find(x => x.id === id);
          if (t) t.likes = a.likes;
          return idx;
        });
      } else {
        const li = loadLocalIndex();
        const t = li.arts.find(x => x.id === id);
        if (t) { t.likes = a.likes; saveLocalIndex(li); }
        S.localIndex = li;
      }
    } catch { }
  }
  // 更新界面
  renderAll();
  if (!$('#lightbox').hidden) {
    const pos = S.lbList.findIndex(x => x.id === id);
    if (pos >= 0) { S.lbPos = pos; updateLbLike(S.lbList[pos]); }
  }
}

/* ---------- 云端索引合并写入 ---------- */
async function mergePutCloud(mutator) {
  const fresh = sanitizeIndex(await cloud.get(S.gid));
  const next = mutator(fresh) || fresh;
  await cloud.put(S.gid, next);
  S.cloudIndex = sanitizeIndex(next);
  return next;
}

/* ---------- 投稿 ---------- */
function openUpload() {
  if (!S.session || !S.session.n) {
    $('#signNamedLabel').hidden = true;
    $('#signLoginHint').hidden = false;
  } else {
    $('#signNamedLabel').hidden = false;
    $('#signLoginHint').hidden = true;
    $('#signNamedTxt').textContent = S.session.n;
    const named = $('input[name=sign][value=named]');
    if (named) named.checked = true;
  }
  $('#uploadModal').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeUpload() {
  $('#uploadModal').hidden = true;
  document.body.style.overflow = '';
}

function handleFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('请选择图片文件（JPG / PNG / WebP）', true); return; }
  if (file.size > 8 * 1024 * 1024) { toast('原图超过 8MB，请压缩后再投稿', true); return; }
  S.pendingFile = file;
  const url = URL.createObjectURL(file);
  const prev = $('#dzPreview');
  prev.src = url;
  prev.hidden = false;
  $('#dzInner').hidden = true;
  $('#dzReset').hidden = false;
  $('#upSubmit').disabled = false;
}

function resetUploadUI() {
  S.pendingFile = null;
  const prev = $('#dzPreview');
  if (prev.src.startsWith('blob:')) URL.revokeObjectURL(prev.src);
  prev.removeAttribute('src');
  prev.hidden = true;
  $('#dzInner').hidden = false;
  $('#dzReset').hidden = true;
  $('#upTitle').value = '';
  $('#upDesc').value = '';
  $('#upSubmit').disabled = true;
  setProgress(null);
}

function setProgress(txt) {
  const el = $('#upProgress');
  el.hidden = !txt;
  el.textContent = txt || '';
}

/* 浏览器端压缩：返回 {data, w, h} */
function compressImage(file, maxEdge, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      try {
        const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        const data = cv.toDataURL('image/jpeg', quality);
        URL.revokeObjectURL(url);
        resolve({ data, w, h });
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
    img.src = url;
  });
}

async function handleUpload() {
  if (!S.pendingFile) { toast('请先选择一张图片', true); return; }
  const title = $('#upTitle').value.trim();
  if (!title) { toast('请给作品起个标题', true); return; }
  const rl = SEC.rateLimit('upload', 5, 60 * 1000);
  if (!rl.ok) { toast(`上传过于频繁，请 ${rl.wait} 秒后再试`, true); return; }
  const token = await requireCaptcha('upload');
  if (!token) return;
  const anon = $('input[name=sign]:checked')?.value !== 'named';
  const by = (!anon && S.session && S.session.n) ? S.session.n : '匿名观众';
  const btn = $('#upSubmit');
  btn.disabled = true;

  try {
    setProgress('正在压缩图像…');
    const main = await compressImage(S.pendingFile, 1400, 0.82);
    let img = main.data;
    if (b64bytes(img) > 900 * 1024) {
      const tighter = await compressImage(S.pendingFile, 1080, 0.6);
      if (b64bytes(tighter.data) > 880 * 1024) throw new Error('图片过于复杂，压缩后仍超限');
      img = tighter.data;
    }
    let thumb = (await compressImage(S.pendingFile, 420, 0.62)).data;
    if (b64bytes(thumb) > 26 * 1024) thumb = (await compressImage(S.pendingFile, 360, 0.48)).data;

    const art = {
      id: uid(), title, desc: $('#upDesc').value.trim(), by,
      ts: Date.now(), likes: 0, w: main.w, h: main.h
    };

    if (S.mode !== 'local') {
      try {
        setProgress('正在连接云端展厅…');
        if (!S.gid) {
          S.gid = await cloud.create(freshIndex());
          localStorage.setItem(LS.gid, S.gid);
          S.cloudIndex = freshIndex();
          S.mode = 'cloud';
          history.replaceState(null, '', '#g=' + S.gid);
          setStatus();
          setTimeout(() => toast('云端展厅已激活！点右上角状态点可复制分享链接', false, 5200), 800);
        }
        setProgress('正在上传作品…');
        const bid = await cloud.create({ id: art.id, ...art, img });
        setProgress('正在更新展厅索引…');
        await mergePutCloud(idx => {
          idx.seq = (idx.seq || 0) + 1;
          idx.arts.push({ id: art.id, bid, no: pad3(idx.seq), title: art.title, desc: art.desc, by: art.by, ts: art.ts, likes: 0, thumb });
          if (idx.arts.length > CLOUD_MAX_ARTS) idx.arts = idx.arts.slice(-CLOUD_MAX_ARTS);
          return idx;
        });
        setProgress(null);
        toast('作品已入馆，全球可见');
      } catch (e) {
        console.warn('cloud upload failed:', e);
        setProgress(null);
        toast('云端不可达，作品已存入本机展厅（仅本机可见）', true, 4600);
        localAdd(art, thumb, img);
        S.mode = 'local';
        setStatus();
      }
    } else {
      setProgress('正在保存到本机…');
      localAdd(art, thumb, img);
      setProgress(null);
      toast('作品已存入本机展厅');
    }
    closeUpload();
    resetUploadUI();
    renderAll(art.id);
    $('#gallery').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    console.warn(e);
    setProgress(null);
    toast(String(e && e.message || '').includes('超限') ? '这张图过于复杂，换一张试试' : '上传失败，请重试', true);
  } finally {
    btn.disabled = false;
  }
}

function localAdd(art, thumb, img) {
  const li = loadLocalIndex();
  li.seq = (li.seq || 0) + 1;
  li.arts.push({ ...art, no: pad3(li.seq), thumb });
  if (li.arts.length > LOCAL_MAX_ARTS) {
    for (const dropped of li.arts.slice(0, li.arts.length - LOCAL_MAX_ARTS)) {
      try { localStorage.removeItem(LS.lart + dropped.id); } catch { }
    }
    li.arts = li.arts.slice(-LOCAL_MAX_ARTS);
  }
  saveLocalIndex(li);
  try { localStorage.setItem(LS.lart + art.id, JSON.stringify({ id: art.id, img })); }
  catch { toast('本机空间不足，已只保留缩略图', true); }
  S.localIndex = li;
}

/* ---------- 账号（邮箱验证码） ---------- */
function renderSession() {
  const authBtn = $('#authBtn'), chip = $('#meChip');
  if (S.session && S.session.n) {
    authBtn.hidden = true;
    chip.hidden = false;
    chip.innerHTML = `<b>${esc(S.session.n[0].toUpperCase())}</b>${esc(S.session.n)}<u style="text-decoration:underline dotted;font-size:10px;color:var(--bone-faint)">退出</u>`;
  } else {
    authBtn.hidden = false;
    chip.hidden = true;
  }
}

function openAuth(mode) {
  S.authMode = mode || 'reg';
  syncAuthUI();
  $('#authModal').hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => $('#auEmail').focus(), 80);
}
function closeAuth() {
  $('#authModal').hidden = true;
  document.body.style.overflow = '';
  clearCodeTimer();
}
function syncAuthUI() {
  $$('#authSeg .seg-btn').forEach(b => b.classList.toggle('is-on', b.dataset.auth === S.authMode));
  const isReg = S.authMode === 'reg';
  $('#authTitle').innerHTML = (isReg ? '注册账号' : '验证码登录') + ' <span class="modal-en">ACCOUNT</span>';
  $('#auSubmit').textContent = isReg ? '创建账号' : '登录';
  $('#auNickField').style.display = isReg ? '' : 'none';
  $('#auPassField').style.display = isReg ? '' : 'none';
  $('#auNote').textContent = isReg
    ? '验证码将发送至你的邮箱，5 分钟内有效。密码以 PBKDF2 加盐哈希存储。'
    : '输入邮箱获取验证码即可登录；也可用邮箱 + 密码登录。';
  $('#auMsg').hidden = true;
}
const auMsg = t => { const el = $('#auMsg'); el.textContent = t; el.hidden = false; };

/* 发送验证码倒计时 */
let codeTimer = null;
function startCodeTimer() {
  clearCodeTimer();
  const btn = $('#auSendCode');
  let sec = 60;
  btn.disabled = true;
  btn.textContent = `重新发送 ${sec}s`;
  codeTimer = setInterval(() => {
    sec--;
    if (sec <= 0) { clearCodeTimer(); btn.disabled = false; btn.textContent = '发送验证码'; }
    else btn.textContent = `重新发送 ${sec}s`;
  }, 1000);
}
function clearCodeTimer() {
  if (codeTimer) { clearInterval(codeTimer); codeTimer = null; }
  const btn = $('#auSendCode');
  if (btn) { btn.disabled = false; btn.textContent = '发送验证码'; }
}

/* 人机验证封装：返回一次性令牌或 null */
let _capHandlers = null;
function requireCaptcha(purpose) {
  return new Promise(resolve => {
    if (_capHandlers) { // 清理上一次残留的监听器
      const { ok, cancel } = _capHandlers;
      $('#capOk').removeEventListener('click', ok);
      $('#capCancel').removeEventListener('click', cancel);
      $('#capClose').removeEventListener('click', cancel);
      _capHandlers = null;
    }
    CAPTCHA.open(purpose);
    const okHandler = () => {
      const token = CAPTCHA.verify();
      if (token) { cleanup(); resolve(token); }
      // token 为 null 时保持弹窗继续尝试
    };
    const cancelHandler = () => { cleanup(); resolve(null); };
    const cleanup = () => {
      $('#capOk').removeEventListener('click', okHandler);
      $('#capCancel').removeEventListener('click', cancelHandler);
      $('#capClose').removeEventListener('click', cancelHandler);
      _capHandlers = null;
    };
    _capHandlers = { ok: okHandler, cancel: cancelHandler };
    $('#capOk').addEventListener('click', okHandler);
    $('#capCancel').addEventListener('click', cancelHandler);
    $('#capClose').addEventListener('click', cancelHandler);
  });
}

/* 发送邮箱验证码 */
async function handleSendCode() {
  const email = $('#auEmail').value.trim().toLowerCase();
  if (!SEC.emailValid(email)) { auMsg('请输入有效的邮箱地址'); return; }
  const rl = SEC.rateLimit('sendcode_' + email, 3, 10 * 60 * 1000);
  if (!rl.ok) { auMsg(`发送过于频繁，请 ${rl.wait} 秒后再试`); return; }
  const token = await requireCaptcha('sendcode');
  if (!token) return;
  if (!MAIL.ready()) {
    auMsg('邮件服务未配置：请先到「安全」面板配置');
    openMail();
    return;
  }
  const btn = $('#auSendCode');
  btn.disabled = true;
  btn.textContent = '发送中…';
  try {
    const code = EMAIL_CODE.issue(email);
    await MAIL.sendCode(email, code);
    auMsg('验证码已发送，请查收邮箱（5 分钟内有效）');
    startCodeTimer();
  } catch (e) {
    console.warn(e);
    auMsg('发送失败：' + (e.message || '请检查邮件服务配置'));
    btn.disabled = false;
    btn.textContent = '发送验证码';
  }
}

/* 按邮箱查找用户（云端优先，本地兜底）。邮箱以哈希形式存储，禁止明文。 */
async function findUserByEmail(email) {
  const key = await SEC.emailKey(email);
  if (S.gid && S.mode !== 'local') {
    try {
      const idx = await cloud.get(S.gid);
      const u = (idx.users || []).find(x => x.em === key);
      if (u) return u;
    } catch { }
  }
  return loadLocalIndex().users.find(x => x.em === key) || null;
}

async function handleAuth() {
  const email = $('#auEmail').value.trim().toLowerCase();
  const code = $('#auCode').value.trim();
  if (!SEC.emailValid(email)) { auMsg('请输入有效的邮箱地址'); return; }
  if (!code) { auMsg('请输入邮箱验证码'); return; }
  const btn = $('#auSubmit');
  btn.disabled = true;

  try {
    if (S.authMode === 'reg') {
      const u = $('#auUser').value.trim();
      if (!SEC.nickValid(u)) { auMsg('昵称需 2–20 位中文/字母/数字/下划线'); return; }
      if (RESERVED_NAMES.includes(u.toLowerCase())) { auMsg('该昵称为馆藏保留名，换一个吧'); return; }
      const p = $('#auPass').value;
      if (p && !SEC.passValid(p)) { auMsg('密码需 ≥8 位且包含字母和数字（或留空）'); return; }
      const v = EMAIL_CODE.verify(email, code);
      if (!v.ok) { auMsg(v.msg); return; }
      const exists = await findUserByEmail(email);
      if (exists) { auMsg('该邮箱已注册，请直接登录'); return; }

      const rec = { em: await SEC.emailKey(email), u, ts: Date.now() };
      if (p) {
        const salt = SEC.randToken(16);
        rec.s = salt;
        rec.h = await SEC.pbkdf2(p, salt);
      }
      let saved = false;
      if (S.mode !== 'local') {
        try {
          if (!S.gid) {
            S.gid = await cloud.create(freshIndex());
            localStorage.setItem(LS.gid, S.gid);
            S.cloudIndex = freshIndex();
            history.replaceState(null, '', '#g=' + S.gid);
            setStatus();
          }
          await mergePutCloud(idx => {
            if (idx.users.some(x => x.em === rec.em)) throw new Error('该邮箱已注册');
            if (idx.users.some(x => x.u.toLowerCase() === u.toLowerCase())) throw new Error('昵称已被注册');
            idx.users.push(rec);
            return idx;
          });
          saved = true;
        } catch (e) {
          if (String(e.message).includes('已注册')) throw e;
          console.warn('reg cloud fail:', e);
        }
      }
      const li = loadLocalIndex();
      if (!li.users.some(x => x.em === rec.em)) {
        li.users.push(rec);
        saveLocalIndex(li);
        S.localIndex = li;
      }
      S.session = { e: rec.em, n: u };
      localStorage.setItem(LS.me, JSON.stringify(S.session));
      toast(saved ? '账号已创建，欢迎入馆' : '账号已创建（本机档案）');
    } else {
      const user = await findUserByEmail(email);
      if (!user) { auMsg('该邮箱未注册，请先注册'); return; }
      const p = $('#auPass').value;
      let authed = false;
      if (code) {
        const v = EMAIL_CODE.verify(email, code);
        if (v.ok) authed = true;
        else if (!p) { auMsg(v.msg); return; }
      }
      if (!authed && p) {
        if (!user.h) { auMsg('该账号未设置密码，请使用验证码登录'); return; }
        const h = await SEC.pbkdf2(p, user.s);
        if (h !== user.h) { auMsg('密码不正确'); return; }
        authed = true;
      }
      if (!authed) { auMsg('请输入验证码或密码'); return; }
      const ekey = await SEC.emailKey(email);
      S.session = { e: ekey, n: user.u };
      localStorage.setItem(LS.me, JSON.stringify(S.session));
      toast(`欢迎回来，${user.u}`);
    }
    closeAuth();
    renderSession();
  } catch (e) {
    auMsg(e.message || '操作失败，请重试');
  } finally {
    btn.disabled = false;
  }
}

/* ---------- 安全设置 ---------- */
function openMail() {
  const cfg = MAIL.load();
  $('#mjService').value = cfg.emailjs.serviceId;
  $('#mjTemplate').value = cfg.emailjs.templateId;
  $('#mjKey').value = cfg.emailjs.publicKey;
  $('#mjTo').value = cfg.formsubmit.toEmail;
  syncMailProvider(cfg.provider);
  $('#mailMsg').hidden = true;
  $('#mailModal').hidden = false;
  document.body.style.overflow = 'hidden';
}
function syncMailProvider(provider) {
  $$('#mailProviderSeg .seg-btn').forEach(b => b.classList.toggle('is-on', b.dataset.provider === provider));
  $('#mailEmailjs').hidden = provider !== 'emailjs';
  $('#mailFormsubmit').hidden = provider !== 'formsubmit';
}
const mailMsg = (t, isErr) => { const el = $('#mailMsg'); el.textContent = t; el.style.color = isErr ? 'var(--verm)' : 'var(--bone-dim)'; el.hidden = false; };
function collectMailCfg() {
  const provider = $('#mailProviderSeg .seg-btn.is-on').dataset.provider;
  return {
    provider,
    emailjs: { serviceId: $('#mjService').value.trim(), templateId: $('#mjTemplate').value.trim(), publicKey: $('#mjKey').value.trim() },
    formsubmit: { toEmail: $('#mjTo').value.trim().toLowerCase() }
  };
}
function handleMailSave() {
  const cfg = collectMailCfg();
  if (cfg.provider === 'emailjs') {
    if (!(cfg.emailjs.serviceId && cfg.emailjs.templateId && cfg.emailjs.publicKey)) { mailMsg('请完整填写 EmailJS 三项配置', true); return; }
  } else {
    if (!SEC.emailValid(cfg.formsubmit.toEmail)) { mailMsg('请输入有效的收件邮箱', true); return; }
  }
  MAIL.save(cfg);
  mailMsg('配置已保存');
  toast('邮件服务配置已保存');
}
async function handleMailTest() {
  const cfg = collectMailCfg();
  const email = cfg.provider === 'emailjs' ? 'test@example.com' : cfg.formsubmit.toEmail;
  if (cfg.provider === 'emailjs') {
    if (!(cfg.emailjs.serviceId && cfg.emailjs.templateId && cfg.emailjs.publicKey)) { mailMsg('请先完整填写 EmailJS 配置', true); return; }
  } else if (!SEC.emailValid(email)) { mailMsg('请先填写有效的收件邮箱', true); return; }
  mailMsg('正在发送测试邮件…');
  try {
    await MAIL.sendCode(email, '123456');
    mailMsg('测试邮件已发送，请查收');
  } catch (e) {
    console.warn(e);
    mailMsg('测试发送失败：' + (e.message || '请检查配置'), true);
  }
}

/* ---------- 分享 ---------- */
function shareLink() {
  const base = location.origin + location.pathname;
  if (!S.gid) { toast('云端展厅还未激活：上传第一件作品后即可分享', true, 4200); return; }
  const url = base + '#g=' + S.gid;
  copyText(url);
}
async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
    toast('链接已复制：' + (t.length > 42 ? t.slice(0, 42) + '…' : t), false, 4200);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('链接已复制'); } catch { toast('复制失败，请手动复制：' + t, true, 6000); }
    ta.remove();
  }
}

/* ---------- 事件绑定 ---------- */
function bindUI() {
  $('#uploadBtn').addEventListener('click', openUpload);
  $$('[data-open-upload]').forEach(b => b.addEventListener('click', openUpload));
  $$('[data-scroll-gallery]').forEach(b => b.addEventListener('click', () => $('#gallery').scrollIntoView({ behavior: 'smooth' })));
  $('#authBtn').addEventListener('click', () => openAuth('reg'));
  $('#signLoginHint').addEventListener('click', () => { closeUpload(); openAuth('reg'); });
  $('#meChip').addEventListener('click', e => {
    if (e.target.tagName === 'U' || confirm(`退出登录 ${S.session.n}？`)) {
      S.session = null; localStorage.removeItem(LS.me); renderSession(); toast('已退出登录');
    }
  });

  // 账号（邮箱验证码）
  $('#auSendCode').addEventListener('click', handleSendCode);
  $('#auCode').addEventListener('input', e => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  });
  $('#auCode').addEventListener('keydown', e => { if (e.key === 'Enter') handleAuth(); });
  $('#auPass').addEventListener('keydown', e => { if (e.key === 'Enter') handleAuth(); });

  // 人机验证
  $('#capRefresh').addEventListener('click', () => CAPTCHA.draw($('#capCanvas')));
  $('#capCanvas').addEventListener('click', () => CAPTCHA.draw($('#capCanvas')));
  $('#capInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#capOk').click(); });
  $('#capOk').addEventListener('click', () => CAPTCHA.verify());
  $('#capCancel').addEventListener('click', CAPTCHA.close);
  $('#capClose').addEventListener('click', CAPTCHA.close);
  document.addEventListener('mousemove', () => CAPTCHA.trackMove());

  // 安全设置
  $('#mailBtn').addEventListener('click', openMail);
  $$('#mailProviderSeg .seg-btn').forEach(b => b.addEventListener('click', () => syncMailProvider(b.dataset.provider)));
  $('#mailSave').addEventListener('click', handleMailSave);
  $('#mailTest').addEventListener('click', handleMailTest);

  // 投稿弹窗
  const dz = $('#dropzone'), fi = $('#fileInput');
  dz.addEventListener('click', e => { if (e.target.id !== 'dzReset') fi.click(); });
  dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } });
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', e => handleFile(e.dataTransfer.files[0]));
  fi.addEventListener('change', () => { handleFile(fi.files[0]); fi.value = ''; });
  $('#dzReset').addEventListener('click', e => { e.stopPropagation(); resetUploadUI(); });
  $('#upSubmit').addEventListener('click', handleUpload);

  // 弹窗通用关闭
  $$('.modal [data-close]').forEach(b => b.addEventListener('click', () => {
    b.closest('.modal').hidden = true;
    document.body.style.overflow = '';
  }));
  $$('.modal').forEach(m => m.addEventListener('click', e => {
    if (e.target === m) { m.hidden = true; document.body.style.overflow = ''; }
  }));

  // 账号
  $$('#authSeg .seg-btn').forEach(b => b.addEventListener('click', () => { S.authMode = b.dataset.auth; syncAuthUI(); }));
  $('#auSubmit').addEventListener('click', handleAuth);

  // 排序 / 筛选
  $$('#sortSeg .seg-btn').forEach(b => b.addEventListener('click', () => {
    $$('#sortSeg .seg-btn').forEach(x => x.classList.remove('is-on'));
    b.classList.add('is-on'); S.sort = b.dataset.sort; renderAll();
  }));
  $$('#filterSeg .seg-btn').forEach(b => b.addEventListener('click', () => {
    $$('#filterSeg .seg-btn').forEach(x => x.classList.remove('is-on'));
    b.classList.add('is-on'); S.filter = b.dataset.filter; renderAll();
  }));

  // 灯箱
  $('#lbClose').addEventListener('click', closeLb);
  $('#lbPrev').addEventListener('click', () => openLb((S.lbPos - 1 + S.lbList.length) % S.lbList.length));
  $('#lbNext').addEventListener('click', () => openLb((S.lbPos + 1) % S.lbList.length));
  $('#lbLike').addEventListener('click', () => { const a = S.lbList[S.lbPos]; if (a) toggleLike(a.id); });
  $('#lightbox').addEventListener('click', e => { if (e.target.id === 'lightbox') closeLb(); });

  // 状态 / 分享
  $('#statusChip').addEventListener('click', () => {
    if (S.mode === 'cloud') shareLink();
    else if (S.mode === 'local') toast('云端不可达：作品暂存在本机浏览器，换网络环境可恢复', false, 4200);
    else toast('首次投稿或注册时会自动创建云端展厅', false, 4200);
  });
  $('#shareBtn').addEventListener('click', shareLink);
}

function bindKeys() {
  document.addEventListener('keydown', e => {
    if (!$('#lightbox').hidden) {
      if (e.key === 'Escape') closeLb();
      else if (e.key === 'ArrowLeft') $('#lbPrev').click();
      else if (e.key === 'ArrowRight') $('#lbNext').click();
    } else if (e.key === 'Escape') {
      $$('.modal').forEach(m => { if (!m.hidden) { m.hidden = true; document.body.style.overflow = ''; } });
    }
  });
}

/* ---------- 启动 ---------- */
document.addEventListener('DOMContentLoaded', init);
