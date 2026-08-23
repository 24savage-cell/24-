/* ============================================================
   野性档案 SAVAGE ARCHIVE · v3.js
   八大新功能：漂流瓶 / 作品评论 / 暗号彩蛋 / 签到集章
              / 每日一画 / 月度人气榜 / 主题切换 / PWA 支持
   ============================================================ */
'use strict';

const V3 = (() => {

  /* ---------- 通用 ---------- */
  const $ = (s, p = document) => p.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDT = ts => {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const toast = (msg, isErr, ms) => {
    try {
      const el = document.createElement('div');
      el.className = 'toast' + (isErr ? ' err' : '');
      el.textContent = msg;
      $('#toasts').appendChild(el);
      setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, ms || 3200);
    } catch (e) {}
  };

  /* ---------- 主题切换 ---------- */
  const THEME = {
    key: 'sa_theme',
    init() {
      let t = 'dark';
      try { t = localStorage.getItem(THEME.key) || 'dark'; } catch (e) {}
      document.documentElement.setAttribute('data-theme', t);
      const btn = $('#themeBtn');
      if (btn) btn.textContent = t === 'dark' ? '☀ 亮' : '🌙 暗';
    },
    toggle() {
      const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', cur);
      try { localStorage.setItem(THEME.key, cur); } catch (e) {}
      const btn = $('#themeBtn');
      if (btn) btn.textContent = cur === 'dark' ? '☀ 亮' : '🌙 暗';
    }
  };

  /* ---------- 漂流瓶 ---------- */
  const BOTTLE = {
    open() { $('#bottleModal').hidden = false; document.body.style.overflow = 'hidden'; $('#bottleMsg').hidden = true; $('#bottleInput').focus(); },
    close() { $('#bottleModal').hidden = true; document.body.style.overflow = ''; },
    async throwMsg() {
      const v = $('#bottleInput').value.trim();
      const msg = $('#bottleMsg');
      if (!v) { msg.textContent = '写点什么再扔'; msg.hidden = false; return; }
      try {
        await db.client().rpc('bottle_throw', { p_content: v, p_session: db.sessionId() });
        msg.textContent = '🍶 瓶子已投入档案馆的时间长河'; msg.hidden = false;
        $('#bottleInput').value = '';
      } catch (e) {
        const t = e.message || '';
        msg.textContent = /RATE_LIMIT/.test(t) ? '扔得太快了，等一会儿再来' : '扔瓶失败：' + t;
        msg.hidden = false;
      }
    },
    async fetchMsg() {
      const out = $('#bottleResult');
      out.innerHTML = '<p class="v3-loading">捞瓶中…</p>';
      try {
        const { data } = await db.client().rpc('bottle_fetch', { p_session: db.sessionId() });
        if (!data || !data.content) { out.innerHTML = '<p class="v3-empty">还没捞到瓶子，长河空空如也</p>'; return; }
        out.innerHTML = `<div class="v3-bottle"><span class="v3-bottle-q">❝</span><p>${esc(data.content)}</p><small>漂到 ${fmtDT(Number(data.ts))}</small></div>`;
      } catch (e) {
        out.innerHTML = '<p class="v3-empty">捞瓶失败，请稍候</p>';
      }
    }
  };

  /* ---------- 暗号彩蛋 ---------- */
  const SECRET = {
    open() { $('#secretModal').hidden = false; document.body.style.overflow = 'hidden'; $('#secretMsg').hidden = true; $('#secretInput').value = ''; $('#secretResult').innerHTML = ''; $('#secretInput').focus(); },
    close() { $('#secretModal').hidden = true; document.body.style.overflow = ''; },
    async check() {
      const code = $('#secretInput').value.trim();
      const res = $('#secretResult'), msg = $('#secretMsg');
      if (!code) { msg.textContent = '输入暗号试试'; msg.hidden = false; return; }
      try {
        const { data } = await db.client().rpc('secret_check', { p_code: code });
        if (data && data.title) {
          msg.hidden = true;
          res.innerHTML = `
            <div class="v3-secret-card">
              ${data.img_url ? `<img src="${esc(data.img_url)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
              <h4>${esc(data.title)}</h4>
              <p>${esc(data.descr || '')}</p>
              <small>🔓 暗格已开启</small>
            </div>`;
        } else {
          msg.textContent = '暗号不对，再想想？'; msg.hidden = false;
        }
      } catch (e) { msg.textContent = '校验失败'; msg.hidden = false; }
    }
  };

  /* ---------- 签到集章 ---------- */
  const STAMP = {
    async open() {
      $('#stampModal').hidden = false;
      document.body.style.overflow = 'hidden';
      $('#stampBody').innerHTML = '<p class="v3-loading">盖章中…</p>';
      try {
        const { data } = await db.client().rpc('stamp_today', { p_session: db.sessionId() });
        const week = ['日', '一', '二', '三', '四', '五', '六'];
        let chips = '';
        for (let i = 6; i >= 0; i--) {
          const d = new Date(Date.now() - i * 86400000);
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          chips += `<span class="stamp-chip${key === data.today ? ' is-today' : ''}">${week[d.getDay()]}<b>${d.getDate()}</b></span>`;
        }
        $('#stampBody').innerHTML = `
          <div class="stamp-seal${data.ok ? ' stamp-pop' : ''}">${data.ok ? '🕹' : '✓'}</div>
          <p class="stamp-line">${data.ok ? '今日盖章成功！' : '今天已经盖过章啦'}</p>
          <p class="stamp-line">🔥 连续 <b>${data.streak}</b> 天 · 累计 <b>${data.total}</b> 枚</p>
          <div class="stamp-week">${chips}</div>
          ${data.streak >= 7 ? '<p class="stamp-title">🏅 已解锁称号：档案馆常客</p>' : data.streak >= 3 ? '<p class="stamp-title">🎖 连续 3 天：档案学徒</p>' : ''}`;
      } catch (e) {
        $('#stampBody').innerHTML = '<p class="v3-empty">签到失败：' + esc(e.message || '') + '</p>';
      }
    },
    close() { $('#stampModal').hidden = true; document.body.style.overflow = ''; }
  };

  /* ---------- 作品评论 ---------- */
  const COMMENTS = {
    cur: null,
    async open(artId) {
      COMMENTS.cur = artId;
      const box = $('#lbComments');
      if (!box) return;
      box.hidden = false;
      const list = $('#lbCommentList'), inp = $('#lbCommentInput');
      inp.value = '';
      list.innerHTML = '<p class="v3-loading">评论加载中…</p>';
      try {
        const { data } = await db.client().rpc('comment_list', { p_art_id: artId });
        if (!data || !data.length) { list.innerHTML = '<p class="v3-empty">还没有评论，来抢沙发</p>'; return; }
        list.innerHTML = '';
        data.forEach(c => {
          const el = document.createElement('div');
          el.className = 'v3-comment';
          el.innerHTML = `<strong>${esc(c.author)}</strong><span>${esc(c.body)}</span><small>${fmtDT(c.ts)}</small>`;
          list.appendChild(el);
        });
      } catch (e) { list.innerHTML = '<p class="v3-empty">评论加载失败</p>'; }
    },
    async send() {
      const inp = $('#lbCommentInput');
      const v = inp.value.trim();
      if (!v || !COMMENTS.cur) return;
      const author = (S.session && S.session.n) ? S.session.n : '游客';
      try {
        await db.client().rpc('comment_add', { p_art_id: COMMENTS.cur, p_body: v, p_author: author, p_session: db.sessionId() });
        inp.value = '';
        COMMENTS.open(COMMENTS.cur);
      } catch (e) {
        toast(/RATE_LIMIT/.test(e.message || '') ? '发言太快，歇一下' : '评论失败', true);
      }
    }
  };

  /* ---------- 每日一画 ---------- */
  const DAILY = {
    render() {
      const el = $('#dailyArt');
      if (!el) return;
      try {
        let arts = [];
        if (typeof currentArts === 'function') arts = currentArts();
        if (!arts.length) return;
        const day = Math.floor(Date.now() / 86400000);
        const pick = arts[day % arts.length];
        el.innerHTML = `
          <div class="daily-card">
            <span class="daily-tag">TODAY'S PICK</span>
            ${pick.thumb ? `<img src="${esc(pick.thumb)}" alt="${esc(pick.title)}" loading="lazy">` : ''}
            <div class="daily-meta">
              <strong>${esc(pick.title)}</strong>
              <span>by ${esc(pick.by || '匿名')} · ${pick.likes || 0} ♥</span>
            </div>
          </div>`;
        el.addEventListener('click', () => {
          const idx = S.lbList ? S.lbList.findIndex(a => a.id === pick.id) : -1;
          if (idx >= 0 && typeof openLb === 'function') openLb(idx);
        });
      } catch (e) {}
    }
  };

  /* ---------- 人气榜 ---------- */
  const RANK = {
    open() {
      const list = $('#rankList');
      $('#rankModal').hidden = false;
      document.body.style.overflow = 'hidden';
      list.innerHTML = '<p class="v3-loading">排榜中…</p>';
      try {
        const arts = (typeof currentArts === 'function' ? currentArts() : []).slice().sort((a, b) => (b.likes || 0) - (a.likes || 0));
        const top = arts.slice(0, 10);
        if (!top.length) { list.innerHTML = '<p class="v3-empty">暂无作品</p>'; return; }
        list.innerHTML = '';
        top.forEach((a, i) => {
          const el = document.createElement('div');
          el.className = 'v3-rank';
          el.innerHTML = `
            <span class="rank-no${i < 3 ? ' rank-top' : ''}">${i + 1}</span>
            ${a.thumb ? `<img src="${esc(a.thumb)}" alt="" loading="lazy">` : ''}
            <div class="rank-meta"><strong>${esc(a.title)}</strong><span>${a.likes || 0} ♥ · by ${esc(a.by || '匿名')}</span></div>`;
          el.addEventListener('click', () => {
            const idx = S.lbList ? S.lbList.findIndex(x => x.id === a.id) : -1;
            if (idx >= 0) { RANK.close(); if (typeof openLb === 'function') openLb(idx); }
          });
          list.appendChild(el);
        });
      } catch (e) { list.innerHTML = '<p class="v3-empty">排行失败</p>'; }
    },
    close() { $('#rankModal').hidden = true; document.body.style.overflow = ''; }
  };

  /* ---------- 初始化 ---------- */
  function bind() {
    $('#bottleOpenBtn')?.addEventListener('click', BOTTLE.open);
    $('#bottleClose')?.addEventListener('click', BOTTLE.close);
    $('#bottleThrow')?.addEventListener('click', BOTTLE.throwMsg);
    $('#bottleFetchBtn')?.addEventListener('click', BOTTLE.fetchMsg);
    $('#secretOpenBtn')?.addEventListener('click', SECRET.open);
    $('#secretClose')?.addEventListener('click', SECRET.close);
    $('#secretGo')?.addEventListener('click', SECRET.check);
    $('#secretInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') SECRET.check(); });
    $('#stampBtn')?.addEventListener('click', STAMP.open);
    $('#stampClose')?.addEventListener('click', STAMP.close);
    $('#themeBtn')?.addEventListener('click', THEME.toggle);
    $('#rankOpenBtn')?.addEventListener('click', RANK.open);
    $('#rankClose')?.addEventListener('click', RANK.close);
    $('#lbCommentSend')?.addEventListener('click', () => COMMENTS.send());
    // 灯箱打开时自动载入评论
    const origOpen = window.openLb;
    if (origOpen) {
      window.openLb = function (...args) {
        const r = origOpen.apply(this, args);
        const a = S.lbList ? S.lbList[args[0]] : null;
        if (a) setTimeout(() => COMMENTS.open(a.id), 300);
        return r;
      };
    }
    // 画廊渲染后刷新每日一画
    const origRender = window.renderAll;
    if (origRender) {
      window.renderAll = function (...args) {
        const r = origRender.apply(this, args);
        setTimeout(DAILY.render, 50);
        return r;
      };
    }
  }

  function init() {
    THEME.init();
    bind();
    setTimeout(DAILY.render, 800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 200));
  } else {
    setTimeout(init, 200);
  }

  return { BOTTLE, SECRET, STAMP, COMMENTS, DAILY, RANK, THEME };
})();
