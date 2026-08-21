/* ============================================================
   野性档案 SAVAGE ARCHIVE · app.js
   云端存储：Supabase（行级权限RLS + 先审后发 + 匿名公开读）
   馆藏：works.json 内置六件；观众投稿需管理员批准后公开
   ============================================================ */
'use strict';

/* ---------- 常量 ---------- */
const LS = {
  me: 'sa_me', likes: 'sa_likes'
};
const RESERVED_NAMES = ['24.savage', '24savage', 'savage', 'admin', 'curator', 'system', 'anonymous', '匿名观众'];

/* ---------- 工具 ---------- */
const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const pad3 = n => String(n).padStart(3, '0');
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

/* ---------- 状态 ---------- */
const S = {
  cloudArts: [],      // 已批准投稿（Supabase）
  seeds: [],
  session: (() => { try { return JSON.parse(localStorage.getItem(LS.me) || 'null'); } catch { return null; } })(),
  sort: 'new',
  filter: 'all',
  lbList: [], lbPos: -1,
  fullCache: new Map(),   // id -> 原图 URL
  pendingFile: null,
  authMode: 'reg',
  adminAuthed: false,
  admView: 'pending',
  subs: [],               // 实时订阅句柄
  chat: { open: false, mode: 'anon', anonId: null, chSub: null }
};

/* ---------- 初始化 ---------- */
async function init() {
  bindUI();
  bindKeys();
  await loadSeeds();
  renderSession();
  await loadCloud();
  renderAll();
  initTicker();
  setStatus();
  subscribeCloud();
  // 访问埋点（不阻塞页面，失败静默）
  db.trackVisit().then(r => {
    if (r && r.banned) {
      try { localStorage.setItem('sa_banned', '1'); } catch (e) {}
      toast('当前网络地址已被馆方限制访问，部分功能不可用', true, 6000);
    }
  });
  const boot = $('#boot');
  setTimeout(() => boot.classList.add('done'), 1000);
  setTimeout(() => boot.classList.add('done'), 2600); // 兜底
}

async function loadSeeds() {
  try {
    const r = await fetch('works.json', { cache: 'force-cache' });
    const data = await r.json();
    S.seeds = (data.arts || []).map(a => ({ ...a, seed: true, likes: Number(a.likes) || 0 }));
  } catch { S.seeds = []; }
}

/* 拉取云端已批准投稿 */
async function loadCloud() {
  try {
    const { data, error } = await withTimeout(db.listApproved(), 12000);
    if (error) throw new Error(error.message);
    S.cloudArts = (data || []).map(a => ({
      id: a.id, no: a.no, title: a.title, desc: a.desc, by: a.by,
      ts: a.ts, likes: Number(a.likes) || 0, w: a.w, h: a.h,
      thumb: db.pubUrl(a.thumb_key), imgkey: a.img_key
    }));
  } catch (e) {
    console.warn('cloud load failed:', e);
    S.cloudArts = [];
    toast('云端暂时不可达，仅展示馆藏', true, 4200);
  }
  setStatus();
}

/* 实时：新批准的作品自动出现 */
function subscribeCloud() {
  const ch = db.subscribeApproved(() => { loadCloud().then(renderAll); });
  S.subs.push(ch);
}

/* ---------- 状态徽标 ---------- */
function setStatus() {
  chip('.chip-init', '.chip-ready', '.chip-local', '● 云端同步中');
}
function chip(...cls) {
  const el = $('#statusChip');
  el.classList.remove('chip-init', 'chip-ready', 'chip-local');
  el.classList.add(cls[2] || cls[1] || 'chip-ready');
  el.textContent = cls[3] || '● 云端同步中';
}

/* ---------- 数据合并与渲染 ---------- */
function currentArts() {
  const map = new Map();
  for (const a of S.seeds) map.set(a.id, { ...a, store: 'seed' });
  for (const a of S.cloudArts) map.set(a.id, { ...a, store: 'cloud' });
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
  const thumb = a.thumb || '';
  el.innerHTML = `
    <div class="plate-imgwrap">
      <span class="plate-no">Nº ${esc(a.no || pad3(i + 1))}</span>
      ${a.seed ? '<span class="plate-seedtag">馆藏</span>' : '<span class="plate-seedtag plate-seedtag-data">投稿</span>'}
      <img data-src="${esc(thumb)}" alt="${esc(a.title)}" loading="lazy">
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
  $('#lbSrc').textContent = a.seed ? '馆藏精选 · CURATED' : '观众投稿 · 云端档案（审核后公开）';
  updateLbLike(a);
  const lb = $('#lightbox');
  lb.hidden = false;
  document.body.style.overflow = 'hidden';

  const img = $('#lbImg'), load = $('#lbLoad');
  img.removeAttribute('src');
  load.hidden = false;
  let src = '';
  if (a.src) src = a.src;
  else if (a.seed) src = '';
  else if (S.fullCache.has(a.id)) src = S.fullCache.get(a.id);
  else if (a.imgkey) {
    src = db.pubUrl(a.imgkey);
    S.fullCache.set(a.id, src);
  }
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
  const liked = !!likes[id];
  // 乐观更新
  if (liked) { delete likes[id]; a.likes = Math.max(0, (a.likes || 0) - 1); a.liked = false; }
  else { likes[id] = 1; a.likes = (a.likes || 0) + 1; a.liked = true; }
  localStorage.setItem(LS.likes, JSON.stringify(likes));
  renderAll();
  if (!$('#lightbox').hidden) {
    const pos = S.lbList.findIndex(x => x.id === id);
    if (pos >= 0) { S.lbPos = pos; updateLbLike(S.lbList[pos]); }
  }
  // 云端计数（仅云端投稿，RPC 受 RLS 保护）
  if (!a.seed && a.store === 'cloud') {
    try {
      const dir = liked ? -1 : 1;
      localStorage.setItem('sa_likedb_' + id, String(Number(localStorage.getItem('sa_likedb_' + id) || 0) + dir));
      await db.like(id);
    } catch { }
  }
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

    setProgress('正在上传至云端（待审核）…');
    await db.submit(art, { imgData: img, thumbData: thumb });
    setProgress(null);
    toast('投稿已提交，待策展人审核后公开展出', false, 4800);
    closeUpload();
    resetUploadUI();
    $('#gallery').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    console.warn(e);
    setProgress(null);
    toast(String(e && e.message || '').includes('超限') ? '这张图过于复杂，换一张试试' : '上传失败：' + (e.message || '请重试'), true, 5000);
  } finally {
    btn.disabled = false;
  }
}

function b64bytes(s) {
  return Math.floor(String(s).length * 0.75);
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
    if (_capHandlers) {
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
    auMsg('邮件服务未配置，请联系馆方');
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

/* 按邮箱查找用户（邮箱以哈希形式存储，禁止明文） */
async function findUserByEmail(email) {
  const key = await SEC.emailKey(email);
  return loadLocalUsers().find(x => x.em === key) || null;
}

function loadLocalUsers() {
  try { return JSON.parse(localStorage.getItem('sa_users') || '[]'); }
  catch { return []; }
}
function saveLocalUsers(users) {
  try { localStorage.setItem('sa_users', JSON.stringify(users)); } catch { }
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
      const users = loadLocalUsers();
      if (!users.some(x => x.em === rec.em)) {
        users.push(rec);
        saveLocalUsers(users);
      }
      S.session = { e: rec.em, n: u };
      localStorage.setItem(LS.me, JSON.stringify(S.session));
      toast('账号已创建，欢迎入馆');
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
    CHAT.updateModeUI();
    if (S.chat.open) CHAT.load();
  } catch (e) {
    auMsg(e.message || '操作失败，请重试');
  } finally {
    btn.disabled = false;
  }
}

/* ---------- 管理后台 ---------- */
function openAdmin() {
  $('#adminModal').hidden = false;
  document.body.style.overflow = 'hidden';
  refreshAdminView();
}
function closeAdmin() {
  $('#adminModal').hidden = true;
  document.body.style.overflow = '';
}
async function refreshAdminView() {
  const { data } = await db.adminSession();
  const authed = !!(data && data.session) && await db.isAdmin();
  S.adminAuthed = authed;
  $('#admLoginView').hidden = authed;
  $('#admPanelView').hidden = !authed;
  $('#admFooter').hidden = false;
  if (authed) {
    const em = data.session.user.email || '管理员';
    $('#admWho').textContent = em.replace(/@.*$/, '') + ' · 已登录';
    // 待审计数
    try {
      const { count } = await db.client().from('art').select('id', { count: 'exact', head: true }).eq('status', 'pending');
      $('#admPendingCnt').textContent = count ? ' ' + count : '';
    } catch { $('#admPendingCnt').textContent = ''; }
    switchView(S.admView);
  } else {
    $('#admEmail').value = S.session && !S.session.e ? '' : '';
    $('#admPass').value = '';
    $('#admMsg').hidden = true;
  }
}
function switchView(v) {
  S.admView = v;
  $$('#admSeg .seg-btn').forEach(b => b.classList.toggle('is-on', b.dataset.adm === v));
  $('#admMailView').hidden = v !== 'mail';
  $('#admListWrap').hidden = !(v === 'pending' || v === 'published');
  $('#admStatsView').hidden = v !== 'stats';
  $('#admLogsView').hidden = v !== 'logs';
  $('#admBansView').hidden = v !== 'bans';
  $('#admUsersView').hidden = v !== 'users';
  if (v === 'mail') { openAdmMail(); return; }
  if (v === 'stats') { renderStats(); return; }
  if (v === 'logs') { renderLogs(); return; }
  if (v === 'bans') { renderBans(); return; }
  if (v === 'users') { renderUsers(); return; }
  renderAdmList(v);
}
async function renderAdmList(v) {
  const wrap = $('#admListWrap');
  wrap.innerHTML = '<p class="au-msg" style="padding:20px 0;text-align:center">加载中…</p>';
  let rows = [];
  try {
    const q = v === 'pending' ? db.listPending() : db.listAll();
    const { data, error } = await q;
    if (error) throw error;
    rows = data || [];
  } catch (e) {
    wrap.innerHTML = '<p class="au-msg" style="color:var(--verm)">读取失败：' + esc(e.message) + '</p>';
    return;
  }
  if (v === 'published') rows = rows.filter(r => r.status === 'approved');
  if (v === 'pending') rows = rows.filter(r => r.status === 'pending');
  if (!rows.length) {
    wrap.innerHTML = '<p class="au-msg" style="padding:20px 0;text-align:center">' + (v === 'pending' ? '暂无待审投稿' : '暂无已发布作品') + '</p>';
    return;
  }
  wrap.innerHTML = '';
  rows.forEach(r => {
    const el = document.createElement('div');
    el.className = 'adm-item';
    el.innerHTML = `
      <img class="adm-thumb" src="${esc(db.pubUrl(r.thumb_key) || r.thumb || '')}" alt="" onerror="this.style.visibility='hidden'">
      <div class="adm-meta">
        <strong>${esc(r.title)}</strong>
        <span class="adm-sub">by ${esc(r.by)} · ${fmtTs(r.ts)}${r.no ? ' · Nº ' + esc(r.no) : ''}</span>
        <span class="adm-desc">${esc(r.desc || '')}</span>
      </div>
      <div class="adm-actions">
        ${r.status !== 'approved' ? `<button class="btn btn-solid btn-s" data-adm-approve="${esc(r.id)}">批准</button>` : `<button class="btn btn-line btn-s" data-adm-reject="${esc(r.id)}">下架</button>`}
        <button class="btn btn-ghost btn-s danger" data-adm-del="${esc(r.id)}">删除</button>
      </div>`;
    wrap.appendChild(el);
  });

  wrap.querySelectorAll('[data-adm-approve]').forEach(b => b.addEventListener('click', () => doApprove(b.dataset.admApprove)));
  wrap.querySelectorAll('[data-adm-reject]').forEach(b => b.addEventListener('click', () => doReject(b.dataset.admReject)));
  wrap.querySelectorAll('[data-adm-del]').forEach(b => b.addEventListener('click', () => doDelete(b.dataset.admDel)));
}

async function doApprove(id) {
  const row = (await db.listAll()).data.find(x => x.id === id);
  if (!row) return;
  const no = pad3(row.no ? Number(String(row.no).replace(/\D/g, '')) : await nextNo());
  const { error } = await db.adminUpdate(id, { status: 'approved', no });
  if (error) { toast('批准失败：' + error.message, true); return; }
  db.logAction('approve', `批准作品 ${row.title}（${id}）`);
  toast('已批准，作品公开展出');
  refreshAdminView(); loadCloud().then(renderAll);
}
async function doReject(id) {
  if (!confirm('下架后作品将不再公开，可再次在待审中批准。继续？')) return;
  const row = (await db.listAll()).data.find(x => x.id === id);
  const { error } = await db.adminUpdate(id, { status: 'pending', no: null });
  if (error) { toast('下架失败：' + error.message, true); return; }
  db.logAction('reject', `下架作品 ${row ? row.title : id}`);
  toast('已下架');
  refreshAdminView(); loadCloud().then(renderAll);
}
async function doDelete(id) {
  if (!confirm('确认永久删除该作品及其图片？此操作不可恢复。')) return;
  const rows = (await db.listAll()).data || [];
  const r = rows.find(x => x.id === id);
  try {
    await db.adminRemove(id, { img_key: r && r.img_key, thumb_key: r && r.thumb_key });
    db.logAction('delete', `删除作品 ${r ? r.title : id}`);
    toast('已永久删除');
    refreshAdminView(); loadCloud().then(renderAll);
  } catch (e) { toast('删除失败：' + e.message, true); }
}
async function nextNo() {
  const { data } = await db.client().from('art').select('no').neq('no', null);
  const nums = (data || []).map(x => Number(String(x.no).replace(/\D/g, '')) || 0);
  return (Math.max(0, ...nums) + 1);
}

/* 邮件服务（仅管理员面板） */
function openAdmMail() {
  const cfg = MAIL.load();
  $('#mjService').value = cfg.emailjs.serviceId || '';
  $('#mjTemplate').value = cfg.emailjs.templateId || '';
  $('#mjKey').value = cfg.emailjs.publicKey || '';
  $('#mailMsg').hidden = true;
}
function handleAdmLogin() {
  const email = $('#admEmail').value.trim().toLowerCase();
  const pass = $('#admPass').value;
  if (!email || !pass) { $('#admMsg').textContent = '请输入邮箱和密码'; $('#admMsg').hidden = false; return; }
  db.adminLogin(email, pass)
    .then(() => {
      $('#admMsg').hidden = true;
      db.logAction('admin_login', '管理员登录后台');
      toast('已登录管理后台');
      refreshAdminView();
    })
    .catch(e => { $('#admMsg').textContent = '登录失败：' + (e.message || '请检查凭证'); $('#admMsg').hidden = false; });
}
async function handleAdmLogout() {
  await db.adminLogout();
  S.adminAuthed = false;
  toast('已退出后台');
  refreshAdminView();
}

/* ---------- 管理后台 2.0 · 访客 / 日志 / 封禁 / 用户 ---------- */
function fmtDT(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function devName(ua) {
  if (!ua) return '未知设备';
  if (/iPhone|iPad/.test(ua)) return 'iPhone/iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Linux/.test(ua)) return 'Linux';
  return (ua.match(/^[^/]+/) || ['未知设备'])[0];
}

/* 访客统计 */
async function renderStats() {
  const cards = $('#mgrStatCards'), list = $('#mgrVisitList');
  cards.innerHTML = '<p class="au-msg" style="padding:16px 0">加载中…</p>';
  try {
    const st = await db.mgrStats();
    if (!st) throw new Error('无数据');
    const mk = (label, val) => `<div class="mgr-card"><strong>${esc(String(val))}</strong><span>${esc(label)}</span></div>`;
    cards.innerHTML =
      mk('今日访问', st.today) + mk('今日独立访客', st.today_uniq) +
      mk('昨日访问', st.yesterday) + mk('累计访问', st.total) + mk('在线峰值', st.online_peak);
    const vs = await db.mgrVisits(30);
    if (!vs.length) { list.innerHTML = '<p class="au-msg" style="padding:16px 0;text-align:center">暂无访问记录</p>'; return; }
    list.innerHTML = '';
    vs.forEach(v => {
      const el = document.createElement('div');
      el.className = 'adm-item';
      el.innerHTML = `
        <div class="adm-meta">
          <strong>${esc(v.ip || 'IP 未知')} <span class="btn-en">${esc(devName(v.ua))}</span></strong>
          <span class="adm-sub">${fmtDT(v.ts)} · ${esc(v.path || '/')}</span>
          <span class="adm-desc">${esc(v.ua || '')}</span>
        </div>`;
      list.appendChild(el);
    });
  } catch (e) {
    cards.innerHTML = '<p class="au-msg" style="color:var(--verm)">读取失败：' + esc(e.message) + '</p>';
  }
}

/* 操作日志 */
async function renderLogs() {
  const list = $('#mgrLogList');
  list.innerHTML = '<p class="au-msg" style="padding:16px 0;text-align:center">加载中…</p>';
  try {
    const rows = await db.mgrAudit(50);
    if (!rows.length) { list.innerHTML = '<p class="au-msg" style="padding:16px 0;text-align:center">暂无操作记录</p>'; return; }
    list.innerHTML = '';
    rows.forEach(r => {
      const el = document.createElement('div');
      el.className = 'adm-item';
      el.innerHTML = `
        <div class="adm-meta">
          <strong>${esc(r.action)} <span class="btn-en">${esc(r.actor_email || '?')}</span></strong>
          <span class="adm-sub">${fmtDT(r.ts)}</span>
          <span class="adm-desc">${esc(r.detail || '')}</span>
        </div>`;
      list.appendChild(el);
    });
  } catch (e) {
    list.innerHTML = '<p class="au-msg" style="color:var(--verm)">读取失败：' + esc(e.message) + '</p>';
  }
}

/* 封禁管理 */
async function renderBans() {
  const list = $('#mgrBanList');
  list.innerHTML = '<p class="au-msg" style="padding:16px 0;text-align:center">加载中…</p>';
  try {
    const rows = await db.mgrBans();
    if (!rows.length) { list.innerHTML = '<p class="au-msg" style="padding:16px 0;text-align:center">暂无封禁</p>'; return; }
    list.innerHTML = '';
    rows.forEach(r => {
      const el = document.createElement('div');
      el.className = 'adm-item';
      const exp = r.expires_at ? fmtDT(r.expires_at) : '永久';
      el.innerHTML = `
        <div class="adm-meta">
          <strong>${esc(r.btype.toUpperCase())} · ${esc(r.value)}${r.active ? '' : ' <span class="btn-en">已解除</span>'}</strong>
          <span class="adm-sub">${esc(r.reason || '无原因')} · 创建 ${fmtDT(r.created_at)} · 到期 ${esc(exp)}</span>
        </div>
        ${r.active ? `<div class="adm-actions"><button class="btn btn-ghost btn-s danger" data-ban-del="${r.id}">解除</button></div>` : ''}`;
      list.appendChild(el);
    });
    list.querySelectorAll('[data-ban-del]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('解除该封禁？')) return;
      try {
        await db.mgrBanRemove(Number(b.dataset.banDel));
        db.logAction('ban_remove', `解除封禁 #${b.dataset.banDel}`);
        toast('已解除'); renderBans();
      } catch (e) { toast('操作失败：' + e.message, true); }
    }));
  } catch (e) {
    list.innerHTML = '<p class="au-msg" style="color:var(--verm)">读取失败：' + esc(e.message) + '</p>';
  }
}
async function submitBan() {
  const type = $('#mgrBanType').value;
  const value = $('#mgrBanValue').value.trim();
  const reason = $('#mgrBanReason').value.trim();
  const expMs = $('#mgrBanExpire').value;
  const msg = $('#mgrBanMsg');
  if (!value) { msg.textContent = '请填写要封禁的值'; msg.hidden = false; return; }
  try {
    const id = await db.mgrBanAdd(type, value, reason || null, expMs ? Date.now() + Number(expMs) : null);
    db.logAction('ban_add', `封禁 ${type}: ${value}（${reason || '无原因'}）`);
    msg.hidden = true;
    $('#mgrBanValue').value = ''; $('#mgrBanReason').value = '';
    toast('封禁已生效'); renderBans();
  } catch (e) {
    msg.textContent = '封禁失败：' + e.message; msg.hidden = false;
  }
}

/* 用户管理 */
async function renderUsers() {
  const list = $('#mgrUserList');
  list.innerHTML = '<p class="au-msg" style="padding:16px 0;text-align:center">加载中…</p>';
  try {
    const rows = await db.mgrUsers();
    if (!rows.length) { list.innerHTML = '<p class="au-msg" style="padding:16px 0;text-align:center">暂无用户</p>'; return; }
    list.innerHTML = '';
    rows.forEach(u => {
      const el = document.createElement('div');
      el.className = 'adm-item';
      const banned = !!u.banned_until;
      el.innerHTML = `
        <div class="adm-meta">
          <strong>${esc(u.email || '?')}${banned ? ' <span class="btn-en">已封禁</span>' : ''}</strong>
          <span class="adm-sub">注册 ${fmtDT(new Date(u.created_at).getTime())} · 最后登录 ${fmtDT(u.last_sign_in_at ? new Date(u.last_sign_in_at).getTime() : 0)}</span>
        </div>
        <div class="adm-actions">
          ${banned
            ? `<button class="btn btn-line btn-s" data-user-unban="${esc(u.email)}">解封</button>`
            : `<button class="btn btn-ghost btn-s danger" data-user-ban="${esc(u.email)}">封禁</button>`}
        </div>`;
      list.appendChild(el);
    });
    list.querySelectorAll('[data-user-ban]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm(`永久封禁 ${b.dataset.userBan}？该用户将无法登录。`)) return;
      try {
        await db.mgrUserBan(b.dataset.userBan, null);
        db.logAction('user_ban', `封禁用户 ${b.dataset.userBan}`);
        toast('已封禁'); renderUsers();
      } catch (e) { toast('操作失败：' + e.message, true); }
    }));
    list.querySelectorAll('[data-user-unban]').forEach(b => b.addEventListener('click', async () => {
      try {
        await db.mgrUserUnban(b.dataset.userUnban);
        db.logAction('user_unban', `解封用户 ${b.dataset.userUnban}`);
        toast('已解封'); renderUsers();
      } catch (e) { toast('操作失败：' + e.message, true); }
    }));
  } catch (e) {
    list.innerHTML = '<p class="au-msg" style="color:var(--verm)">读取失败：' + esc(e.message) + '</p>';
  }
}

/* ---------- 分享 ---------- */
function shareLink() {
  copyText(location.origin + location.pathname);
}
async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
    toast('链接已复制');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('链接已复制'); } catch { toast('复制失败', true); }
    ta.remove();
  }
}

/* ---------- 事件绑定 ---------- */
function bindUI() {
  $('#uploadBtn').addEventListener('click', openUpload);
  $$('[data-open-upload]').forEach(b => b.addEventListener('click', openUpload));
  $$('[data-scroll-gallery]').forEach(b => b.addEventListener('click', () => $('#gallery').scrollIntoView({ behavior: 'smooth' })));
  $$('[data-scroll-notes]').forEach(b => b.addEventListener('click', () => { const n = $('#notes'); if (n) n.scrollIntoView({ behavior: 'smooth' }); }));
  $('#authBtn').addEventListener('click', () => openAuth('reg'));
  $('#signLoginHint').addEventListener('click', () => { closeUpload(); openAuth('reg'); });
  $('#meChip').addEventListener('click', e => {
    if (e.target.tagName === 'U' || confirm(`退出登录 ${S.session.n}？`)) {
      S.session = null; localStorage.removeItem(LS.me); renderSession(); toast('已退出登录');
      CHAT.updateModeUI();
    }
  });

  // 聊天室
  $('#chatOpenBtn').addEventListener('click', () => CHAT.open());
  $('#chatClose').addEventListener('click', () => CHAT.close());
  $('#chatModeAnon').addEventListener('click', () => { S.chat.mode = 'anon'; CHAT.updateModeUI(); });
  $('#chatModeAct').addEventListener('click', () => {
    if (!S.session || !S.session.n) { toast('登录账号后可使用账号身份发言', true); openAuth('reg'); return; }
    S.chat.mode = 'account'; CHAT.updateModeUI();
  });
  $('#chatForm').addEventListener('submit', e => {
    e.preventDefault();
    const inp = $('#chatBox');
    CHAT.send(inp.value).finally(() => { inp.value = ''; });
  });

  // 管理后台
  $('#adminEntry').addEventListener('click', openAdmin);
  $('#admLogin').addEventListener('click', handleAdmLogin);
  $('#admPass').addEventListener('keydown', e => { if (e.key === 'Enter') handleAdmLogin(); });
  $('#admLogout').addEventListener('click', handleAdmLogout);
  $$('#admSeg .seg-btn').forEach(b => b.addEventListener('click', () => switchView(b.dataset.adm)));
  $('#mgrBanAdd').addEventListener('click', submitBan);

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

  // 邮件服务保存/测试（仅后台）
  $('#mailSave').addEventListener('click', handleMailSave);
  $('#mailTest').addEventListener('click', handleMailTest);
  $('#mjReveal').addEventListener('click', () => {
    const inp = $('#mjKey');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    $('#mjReveal').textContent = inp.type === 'password' ? '显示' : '隐藏';
  });

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

  // 分享
  $('#statusChip').addEventListener('click', () => { if (S.cloudArts.length >= 0) shareLink(); });
  $('#shareBtn').addEventListener('click', shareLink);
}

/* 邮件服务设置处理（拼装/校验/保存与测试，凭证已在后台页） */
function collectMailCfg() {
  const cfg = MAIL.load();
  cfg.emailjs.serviceId = $('#mjService').value.trim();
  cfg.emailjs.templateId = $('#mjTemplate').value.trim();
  cfg.emailjs.publicKey = $('#mjKey').value.trim();
  return cfg;
}
function handleMailSave() {
  const cfg = collectMailCfg();
  if (!(cfg.emailjs.serviceId && cfg.emailjs.templateId && cfg.emailjs.publicKey)) { mailMsg('请完整填写 EmailJS 三项配置', true); return; }
  MAIL.save(cfg);
  mailMsg('配置已保存');
  toast('邮件服务配置已保存');
}
async function handleMailTest() {
  const cfg = collectMailCfg();
  if (!(cfg.emailjs.serviceId && cfg.emailjs.templateId && cfg.emailjs.publicKey)) { mailMsg('请先完整填写 EmailJS 配置', true); return; }
  mailMsg('正在发送测试邮件…');
  try {
    await MAIL.sendCode(cfg.formsubmit.toEmail || 'test@example.com', '123456');
    mailMsg('测试邮件已发送，请查收');
  } catch (e) {
    console.warn(e);
    mailMsg('测试发送失败：' + (e.message || '请检查配置'), true);
  }
}
function mailMsg(t, isErr) {
  const el = $('#mailMsg');
  el.textContent = t;
  el.style.color = isErr ? 'var(--verm)' : 'var(--bone-dim)';
  el.hidden = false;
}

/* ---------- 聊天室 ---------- */
const CHAT = {
  ANON_LS: 'sa_chat_anon',

  anonName() {
    let id = localStorage.getItem(this.ANON_LS);
    if (!id) { id = uid().slice(0, 6); localStorage.setItem(this.ANON_LS, id); }
    return '游客·' + id;
  },
  anonKey() {
    let id = localStorage.getItem(this.ANON_LS);
    if (!id) { id = uid().slice(0, 12); localStorage.setItem(this.ANON_LS, id); }
    return id;
  },

  open() {
    if (S.chat.open) return;
    S.chat.open = true;
    $('#chatModal').hidden = false;
    document.body.style.overflow = 'hidden';
    this.updateModeUI();
    this.load();
    if (!S.chat.chSub) {
      S.chat.chSub = db.subscribeChat(row => this.onNew(row));
    }
    setTimeout(() => $('#chatBox').focus(), 120);
  },
  close() {
    S.chat.open = false;
    $('#chatModal').hidden = true;
    document.body.style.overflow = '';
  },

  currentMode() { return S.chat.mode; },
  identity() {
    if (S.chat.mode === 'account' && S.session && S.session.n) {
      return { author: S.session.n, kind: 'account', key: S.session.e ? 'acct:' + S.session.e : 'acct:session' };
    }
    return { author: this.anonName(), kind: 'anon', key: 'anon:' + this.anonKey() };
  },

  updateModeUI() {
    const isAccount = S.chat.mode === 'account' && S.session && S.session.n;
    $('#chatModeAnon').classList.toggle('is-on', !isAccount);
    $('#chatModeAct').classList.toggle('is-on', isAccount);
    if (isAccount) {
      $('#chatHint').textContent = '以账号「' + S.session.n + '」身份发言';
      $('#chatModeAct').title = '当前账号：' + S.session.n;
    } else {
      $('#chatHint').textContent = '以「' + this.anonName() + '」匿名发言';
      $('#chatModeAct').title = '登录账号后可用账号身份';
    }
  },

  async load() {
    const list = $('#chatList');
    list.innerHTML = '<li class="chat-loading">正在进入观展厅…</li>';
    try {
      const msgs = await db.chatRecent(60);
      list.innerHTML = '';
      if (!msgs.length) {
        list.innerHTML = '<li class="chat-system">— 还没有人说话，来开个头吧 —</li>';
      } else {
        msgs.forEach(m => this.renderMsg(m, false));
      }
      this.scrollBottom(false);
    } catch (e) {
      console.warn('chat load failed', e);
      list.innerHTML = '<li class="chat-loading">云端聊天暂时不可达，请稍后再试</li>';
    }
  },

  renderMsg(m, isNew) {
    const list = $('#chatList');
    const id = 'chat-' + m.id;
    if (document.getElementById(id)) return;
    const li = document.createElement('li');
    li.id = id;
    li.className = 'chat-msg other';
    const me = this.isMine(m);
    if (me) li.classList.add('me');
    const kindTag = m.kind === 'account' ? '<span class="chat-kind">账号</span>' : (m.kind === 'seed' ? '<span class="chat-kind">馆方</span>' : '');
    const author = m.kind === 'seed' ? (m.author || '24.savage') : m.author;
    li.innerHTML = `<span class="chat-name">${esc(author)}${kindTag}${me ? ' · 你' : ''}</span>${esc(m.body)}`;
    list.appendChild(li);
    if (isNew) this.scrollBottom(true);
  },

  /* 判断是否本人消息：匿名用会话ID，账号用昵称 */
  isMine(m) {
    const ident = this.identity();
    if (ident.kind === 'anon' && m.kind === 'anon') {
      return m.author === ident.author;
    }
    return ident.kind === 'account' && m.kind === 'account' && m.author === ident.author;
  },

  scrollBottom(smooth) {
    const list = $('#chatList');
    list.scrollTop = list.scrollHeight;
  },

  onNew(row) {
    const payload = row.new || row;
    if (S.chat.open) this.renderMsg(payload, true);
  },

  async send(text) {
    const t = (text || '').trim();
    if (!t) return;
    const ident = this.identity();
    if (ident.kind === 'account' && !S.session) { toast('请先登录账号', true); return; }
    try {
      const id = await db.chatSend(t, ident.author, ident.kind, ident.key);
      // 乐观更新：发送成功立即插入本地，避免依赖 Realtime 回流延迟
      if (id && S.chat.open) {
        this.renderMsg({ id, body: t, author: ident.author, kind: ident.kind, ts: Date.now() }, true);
      }
      this.updateModeUI();
    } catch (e) {
      toast(e.message || '发送失败', true);
    }
  }
};

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