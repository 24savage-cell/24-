/* ============================================================
   野性档案 SAVAGE ARCHIVE · security.js
   人机验证（图形验证码 + 行为分析 + 一次性令牌）
   安全工具（PBKDF2 哈希 / 邮箱校验 / 限频 / XSS 转义）
   ============================================================ */
'use strict';

/* ---------- 安全工具 ---------- */
const SEC = {
  /* XSS 转义（加强版，覆盖所有危险字符与协议） */
  esc(s) {
    return String(s ?? '').replace(/[&<>"'`=/]/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;', '=': '&#61;', '/': '&#47;'
    }[c]));
  },

  /* 邮箱格式校验（RFC 近似 + 常见域名黑名单） */
  emailValid(email) {
    const e = String(email || '').trim().toLowerCase();
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) return false;
    if (e.length > 254) return false;
    const local = e.split('@')[0];
    if (local.length > 64) return false;
    if (/[+]/g.test(local)) return false; // 拒绝 + 别名（防滥用）
    const badDomains = ['mailinator.com', '10minutemail.com', 'guerrillamail.com', 'yopmail.com', 'temp-mail.org', 'throwawaymail.com', 'maildrop.cc', 'sharklasers.com', 'getnada.com', 'tempail.com', 'dispostable.com', 'mohmal.com', 'emailondeck.com', 'fakeinbox.com', 'tempmail.com'];
    const dom = e.split('@')[1];
    if (badDomains.includes(dom)) return false;
    return true;
  },

  /* 昵称校验：2–20 位中文/字母/数字/下划线/点/连字符 */
  nickValid(n) {
    return /^[\u4e00-\u9fa5A-Za-z0-9_·\-.]{2,20}$/.test(String(n || '').trim());
  },

  /* 强密码校验：≥8 位，含字母+数字 */
  passValid(p) {
    return /^(?=.*[A-Za-z])(?=.*\d).{8,64}$/.test(String(p || ''));
  },

  /* 通用 SHA-256 十六进制摘要 */
  async sha256(text) {
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  },

  /* 邮箱脱敏标识：加常量盐(PEPPER)+小写邮箱，做 SHA-256，杜绝明文邮箱落盘 */
  async emailKey(email) {
    const e = String(email || '').trim().toLowerCase();
    return SEC.sha256('savage::v2::pepper::' + e);
  },

  /* PBKDF2 加盐哈希（比 SHA-256 抗暴力破解强得多） */
  async pbkdf2(password, salt, iterations = 120000) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: enc.encode(salt), iterations, hash: 'SHA-256' },
      key, 256
    );
    return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  },

  /* 随机安全令牌 */
  randToken(len = 32) {
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
  },

  /* 限频器：key -> {count, until} */
  _rl: {},
  rateLimit(key, max, windowMs) {
    const now = Date.now();
    const r = SEC._rl[key];
    if (!r || now > r.until) {
      SEC._rl[key] = { count: 1, until: now + windowMs };
      return { ok: true, remain: max - 1 };
    }
    r.count++;
    if (r.count > max) {
      return { ok: false, remain: 0, wait: Math.ceil((r.until - now) / 1000) };
    }
    return { ok: true, remain: max - r.count };
  },
  rateClear(key) { delete SEC._rl[key]; }
};

/* ---------- 一次性令牌（防重放） ---------- */
const ONETIME = {
  _store: {},
  issue(purpose, ttlMs = 120000) {
    const t = SEC.randToken(16);
    ONETIME._store[t] = { purpose, exp: Date.now() + ttlMs, used: false };
    return t;
  },
  verify(token, purpose) {
    const r = ONETIME._store[token];
    if (!r) return false;
    if (r.used || r.purpose !== purpose || Date.now() > r.exp) {
      delete ONETIME._store[token];
      return false;
    }
    r.used = true;
    delete ONETIME._store[token];
    return true;
  }
};

/* ============================================================
   人机验证 CAPTCHA
   图形验证码（Canvas 扭曲字符 + 干扰线 + 噪点）
   + 行为分析（时间 / 鼠标轨迹 / 输入节奏）
   + 一次性令牌
   ============================================================ */
const CAPTCHA = {
  /* 排除易混淆字符 0O1Il */
  CHARS: '23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz',
  _answer: '',
  _token: '',
  _born: 0,
  _moves: 0,
  _purpose: '',
  _fail: 0,
  _lockedUntil: 0,

  /* 生成验证码并绘制到 canvas */
  draw(canvas) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // 背景：档案暗色
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#161411');
    bg.addColorStop(1, '#0e0d0b');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // 干扰线
    ctx.strokeStyle = 'rgba(255,75,31,.35)';
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      ctx.moveTo(Math.random() * W, Math.random() * H);
      ctx.bezierCurveTo(
        Math.random() * W, Math.random() * H,
        Math.random() * W, Math.random() * H,
        Math.random() * W, Math.random() * H
      );
      ctx.lineWidth = 1 + Math.random();
      ctx.stroke();
    }

    // 字符
    const code = [];
    for (let i = 0; i < 4; i++) code.push(CAPTCHA.CHARS[Math.floor(Math.random() * CAPTCHA.CHARS.length)]);
    CAPTCHA._answer = code.join('');

    const cellW = W / 5;
    code.forEach((ch, i) => {
      const x = cellW * (i + 0.8);
      const y = H / 2 + (Math.random() * 10 - 5);
      const rot = (Math.random() * 0.5 - 0.25);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.font = `700 ${H * 0.55}px "IBM Plex Mono", monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // 描边 + 填充（骨白字符，随机朱红点缀）
      ctx.strokeStyle = 'rgba(255,75,31,.6)';
      ctx.lineWidth = 1.5;
      ctx.strokeText(ch, 0, 0);
      ctx.fillStyle = Math.random() > 0.5 ? '#ece5d8' : '#ffb59e';
      ctx.fillText(ch, 0, 0);
      ctx.restore();
    });

    // 噪点
    for (let i = 0; i < 60; i++) {
      ctx.fillStyle = `rgba(236,229,216,${Math.random() * 0.4})`;
      ctx.fillRect(Math.random() * W, Math.random() * H, 1.2, 1.2);
    }

    // 记录生成时间与令牌
    CAPTCHA._born = Date.now();
    CAPTCHA._token = SEC.randToken(12);
    CAPTCHA._moves = 0;
  },

  /* 行为采集：鼠标移动 */
  trackMove() { CAPTCHA._moves++; },

  /* 打开验证弹窗 */
  open(purpose) {
    CAPTCHA._purpose = purpose;
    CAPTCHA._fail = 0;
    CAPTCHA._lockedUntil = 0;
    const modal = $('#captchaModal');
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    const cv = $('#capCanvas');
    CAPTCHA.draw(cv);
    $('#capInput').value = '';
    $('#capMsg').hidden = true;
    $('#capInput').focus();
  },

  close() {
    $('#captchaModal').hidden = true;
    document.body.style.overflow = '';
  },

  /* 校验 */
  verify() {
    const now = Date.now();
    if (now < CAPTCHA._lockedUntil) {
      const wait = Math.ceil((CAPTCHA._lockedUntil - now) / 1000);
      CAPTCHA._msg(`尝试过于频繁，请 ${wait} 秒后再试`, true);
      return null;
    }
    const input = $('#capInput').value.trim();
    if (!input) { CAPTCHA._msg('请输入验证码', true); return null; }

    // 行为分析：生成到提交 < 1.2 秒 或 无鼠标移动 → 判定机器人
    const elapsed = now - CAPTCHA._born;
    if (elapsed < 1200 || CAPTCHA._moves < 3) {
      CAPTCHA._fail++;
      if (CAPTCHA._fail >= 3) CAPTCHA._lockedUntil = Date.now() + 30000;
      CAPTCHA._msg('检测到异常操作，请重试', true);
      CAPTCHA.draw($('#capCanvas'));
      $('#capInput').value = '';
      return null;
    }

    if (input.toLowerCase() !== CAPTCHA._answer.toLowerCase()) {
      CAPTCHA._fail++;
      if (CAPTCHA._fail >= 5) CAPTCHA._lockedUntil = Date.now() + 600000; // 5 次错误锁 10 分钟
      CAPTCHA._msg(`验证码不正确（剩余 ${5 - CAPTCHA._fail} 次）`, true);
      CAPTCHA.draw($('#capCanvas'));
      $('#capInput').value = '';
      return null;
    }

    // 通过：发放一次性令牌
    const token = ONETIME.issue(CAPTCHA._purpose);
    CAPTCHA.close();
    return token;
  },

  _msg(t, isErr) {
    const el = $('#capMsg');
    el.textContent = t;
    el.style.color = isErr ? 'var(--verm)' : 'var(--bone-dim)';
    el.hidden = false;
  }
};

/* ============================================================
   邮箱验证码
   验证码生成 / 存储（本机 + 过期）/ 校验 / 限频
   ============================================================ */
const EMAIL_CODE = {
  LS_KEY: 'sa_email_codes',
  TTL: 5 * 60 * 1000,        // 5 分钟有效
  COOLDOWN: 60 * 1000,       // 60 秒重发冷却
  MAX_ATTEMPTS: 5,           // 最多错误 5 次

  _load() {
    try { return JSON.parse(localStorage.getItem(EMAIL_CODE.LS_KEY) || '{}'); }
    catch { return {}; }
  },
  _save(o) {
    try { localStorage.setItem(EMAIL_CODE.LS_KEY, JSON.stringify(o)); } catch { }
  },

  /* 生成并保存验证码（返回明文用于发送） */
  issue(email) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const store = EMAIL_CODE._load();
    store[email] = {
      code,
      exp: Date.now() + EMAIL_CODE.TTL,
      attempts: 0,
      lastSent: Date.now()
    };
    EMAIL_CODE._save(store);
    return code;
  },

  /* 校验：一次性 + 未过期 + 未超错 */
  verify(email, input) {
    const store = EMAIL_CODE._load();
    const rec = store[email];
    if (!rec) return { ok: false, msg: '请先获取验证码' };
    if (Date.now() > rec.exp) {
      delete store[email];
      EMAIL_CODE._save(store);
      return { ok: false, msg: '验证码已过期，请重新获取' };
    }
    if (rec.attempts >= EMAIL_CODE.MAX_ATTEMPTS) {
      delete store[email];
      EMAIL_CODE._save(store);
      return { ok: false, msg: '错误次数过多，请重新获取验证码' };
    }
    if (String(input).trim() !== rec.code) {
      rec.attempts++;
      EMAIL_CODE._save(store);
      return { ok: false, msg: `验证码错误（剩余 ${EMAIL_CODE.MAX_ATTEMPTS - rec.attempts} 次）` };
    }
    delete store[email];
    EMAIL_CODE._save(store);
    return { ok: true };
  },

  /* 是否在冷却期 */
  cooldown(email) {
    const rec = EMAIL_CODE._load()[email];
    if (!rec) return 0;
    const wait = rec.lastSent + EMAIL_CODE.COOLDOWN - Date.now();
    return wait > 0 ? Math.ceil(wait / 1000) : 0;
  }
};
