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
    $('#admEmail').value = S.session