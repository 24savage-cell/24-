/* ============================================================
   野性档案 SAVAGE ARCHIVE · features.js
   功能扩展：在线人数 / 声匣音乐 / 每日信标 / 随机抽件 / 彩蛋
   - 在线人数：Supabase Realtime Presence（连接即在场）
   - 声匣音乐：Internet Archive 公开音频档案馆（免费试听/下载）
   - 每日信标：按日期确定性生成的档案馆今日签
   - 随机抽件：从展厅随机抽取一件作品
   ============================================================ */
'use strict';

(function () {
  const F = window.FEATURES = {
    init() {
      this.armPresence();
      this.armMusic();
      this.armFaith();
      this.armShuffle();
      this.armKeys();
    },

    /* ==========================================================
       在线人数 · Online Presence
       ========================================================== */
    presence: { ch: null, last: 0 },
    armPresence() {
      const chip = $('#onlineChip');
      if (!chip) return;
      const update = (n) => {
        if (n === this.presence.last) return;
        this.presence.last = n;
        chip.hidden = false;
        chip.textContent = '● ' + n + (n > 1 ? ' 人在线' : ' 人在线');
      };
      try {
        const sb = db.client();
        if (!sb || !sb.channel) { chip.textContent = '● 在线统计不可用'; chip.hidden = false; return; }
        const ch = sb.channel('archive-online-presence');
        this.presence.ch = ch;
        ch.on('presence', { event: 'sync' }, () => {
          const st = ch.presenceState() || {};
          update(Object.keys(st).length || 1);
        });
        ch.on('presence', { event: 'join' }, () => { });
        ch.subscribe(async (status) => {
          if (status === 'SUBSCRIBED') {
            try { await ch.track({ at: Date.now() }); } catch { }
          }
        });
      } catch (e) {
        console.warn('presence unavailable:', e);
        chip.textContent = '● 在线统计离线';
        chip.hidden = false;
      }
    },

    /* ==========================================================
       声匣音乐 · Music Box（走后端代理，前端绝不直连第三方）
       MUSIC_API_BASE 指向 Supabase Edge Function 代理（GD音乐台免费API）。
       后端未部署时优雅降级并提示，而不是偷偷回落到直连。
       ========================================================== */
    music: {
      audio: new Audio(),
      cur: null,
      // 默认同源 /backend 前缀；部署到独立域名时改这里
      apiBase:
        (window.__MUSIC_API__ && window.__MUSIC_API__.base) ||
        'https://vqjyhsznnuskxhsmfdxx.supabase.co/functions/v1/music-proxy'
    },
    armMusic() {
      const open = $('#musicOpenBtn'), mb = $('#musicModal');
      if (!open || !mb) return;
      open.addEventListener('click', () => {
        mb.hidden = false;
        document.body.style.overflow = 'hidden';
        setTimeout(() => $('#muQuery').focus(), 80);
      });
      $('#muGo').addEventListener('click', () => this.musicSearch());
      $('#muQuery').addEventListener('keydown', e => { if (e.key === 'Enter') this.musicSearch(); });
    },
    fmtDur(sec) {
      if (!sec) return '';
      const m = Math.floor(sec / 60), s = String(sec % 60).padStart(2, '0');
      return m + ':' + s;
    },
    async musicSearch() {
      const q = $('#muQuery').value.trim();
      const list = $('#muList'), msg = $('#muMsg');
      if (!q) { msg.textContent = '请输入要搜索的音乐关键词'; msg.hidden = false; return; }
      msg.hidden = true;
      this.musicPlayStop();
      list.innerHTML = '<li class="chat-loading">正在通过档案馆声匣检索…</li>';
      try {
        const url = this.music.apiBase + '?target=search&source=netease&name=' + encodeURIComponent(q) + '&count=20&pages=1';
        const res = await fetch(url, { cache: 'no-store' });
        if (res.status === 429) {
          list.innerHTML = '<li class="chat-loading">检索太频繁，请稍候片刻再试。</li>';
          return;
        }
        let j = null;
        try { j = await res.json(); } catch { }
        if (!res.ok || (Array.isArray(j) ? false : j && j.error)) {
          const reason = (j && j.error) || ('HTTP ' + res.status);
          list.innerHTML = '<li class="chat-loading">声匣暂时不可达：' + esc(reason) + '</li>';
          return;
        }
        const docs = Array.isArray(j) ? j : [];
        if (!docs.length) { list.innerHTML = '<li class="chat-loading">没有找到相关曲目，换个词试试。</li>'; return; }
        list.innerHTML = '';
        docs.forEach(d => list.appendChild(this.musicRow(d)));
      } catch (e) {
        console.warn(e);
        list.innerHTML = '<li class="chat-loading">声匣后端暂时不可达，请稍后再试。<br>（如未部署自托管后端，前端不会替代它直连第三方）</li>';
      }
    },
    musicRow(d) {
      const li = document.createElement('li');
      li.className = 'music-item';
      const cover = ''; // 封面异步可选；此处用占位
      const artist = Array.isArray(d.artist) ? d.artist.join(' / ') : (d.artist || '未知艺术家');
      li.innerHTML = `
        <div class="music-cover">${cover ? `<img loading="lazy" src="${esc(cover)}" alt="">` : '<span class="music-cover-glyph">♪</span>'}</div>
        <div class="music-info">
          <strong>${esc(d.name || d.title || '未知曲名')}</strong>
          <small>${esc(artist)}${d.album ? ' · ' + esc(d.album) : ''}</small>
        </div>
        <div class="music-acts">
          <button class="btn btn-line btn-s" type="button" data-play>试听 <span class="btn-en">PLAY</span></button>
          <button class="btn btn-ghost btn-s" type="button" data-dl>取链 <span class="btn-en">LINK</span></button>
        </div>`;
      li.__track = d;
      li.querySelector('[data-play]').addEventListener('click', () => this.musicPlay(li));
      li.querySelector('[data-dl]').addEventListener('click', () => this.musicFetchPlayUrl(li));
      return li;
    },
    // 向后端申请该曲目的临时播放票据
    async musicFetchTrackUrl(li) {
      const d = li.__track;
      if (!d || !d.url_id) throw new Error('无曲目ID');
      const url = this.music.apiBase + '?target=url&source=netease&id=' + encodeURIComponent(d.url_id) + '&br=128';
      const res = await fetch(url);
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j || !j.url) throw new Error((j && j.error) || ('HTTP ' + res.status));
      return j.url;
    },
    async musicPlay(li) {
      // 先拿临时播放地址，关键：即使后端只回直链，也非前端自己编的
      let url;
      try { url = await this.musicFetchTrackUrl(li); }
      catch (e) { toast('取播放地址失败：' + e.message, true, 4200); return; }
      if (!url) { toast('该源暂未返回可播放地址，换一首试试', true, 4200); return; }
      const a = this.music.audio;
      if (this.music.cur === li && !a.paused) { a.pause(); this.musicSyncBtn(li, false); return; }
      this.musicPlayStop();
      this.music.cur = li;
      a.src = url;
      a.onended = () => this.musicSyncBtn(li, false);
      a.onpause = () => this.musicSyncBtn(li, false);
      a.play().then(() => this.musicSyncBtn(li, true)).catch(() => this.musicSyncBtn(li, false));
    },
    musicFetchPlayUrl(li) {
      this.musicFetchTrackUrl(li)
        .then(url => { if (url) { window.open(url, '_blank', 'noopener'); toast('已打开临时试听地址'); } else toast('暂无直链，可先试听', true, 3600); })
        .catch(e => toast('取链失败：' + e.message, true, 4200));
    },
    musicSyncBtn(li, playing) {
      if (!li) return;
      const pb = li.querySelector('[data-play]');
      if (pb) {
        pb.innerHTML = playing ? '暂停 <span class="btn-en">PAUSE</span>' : '试听 <span class="btn-en">PLAY</span>';
        pb.classList.toggle('is-playing', playing);
      }
    },
    musicPlayStop() {
      const a = this.music.audio;
      if (this.music.cur) this.musicSyncBtn(this.music.cur, false);
      this.music.cur = null;
      try { a.pause(); a.removeAttribute('src'); a.load(); } catch { }
    },

    /* ==========================================================
       每日信标 · Daily Beacon（确定性签文）
       ========================================================== */
    armFaith() {
      const open = $('#faithOpenBtn'), fb = $('#faithModal');
      if (!open || !fb) return;
      open.addEventListener('click', () => { this.faithFill(); fb.hidden = false; document.body.style.overflow = 'hidden'; });
    },
    faithFill() {
      const poem = this.faithDaily();
      $('#faithKicker').textContent = '第 ' + this.faithDayNo() + ' 天 · ' + this.faithDate();
      $('#faithQuote').innerHTML = poem.text;
      $('#faithSrc').textContent = '—— 档案馆「' + poem.id + '」';
      $('#faithNote').textContent = '信标随日期流转，与你一同驻守此刻。';
    },
    faithDaily() {
      const list = FEATURES.FAITH_POEMS;
      const idx = this.faithDayNo() % list.length;
      return list[idx];
    },
    faithDayNo() {
      const base = new Date('2026-01-01T00:00:00+08:00');
      const now = new Date();
      return Math.max(1, Math.floor((now - base) / 86400000) + 1);
    },
    faithDate() {
      const d = new Date();
      return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
    },

    /* ==========================================================
       随机抽件 · Shuffle（抽一件作品）
       ========================================================== */
    armShuffle() {
      const btn = $('#shuffleBtn');
      if (!btn) return;
      btn.addEventListener('click', () => {
        const arr = S.lbList.length ? S.lbList : applyLikes(currentArts());
        if (!arr.length) { toast('展厅暂时为空，无法抽取', true); return; }
        S.lbList = arr;
        const idx = Math.floor(Math.random() * arr.length);
        S.lbPos = idx;
        openLb(idx);
      });
    },

    /* ==========================================================
       彩蛋 · 键盘彩蛋（依次输入 S-A-V-A-G-E）
       ========================================================== */
    armKeys() {
      const seq = 'savage';
      let buf = '';
      document.addEventListener('keydown', e => {
        const k = (e.key || '').toLowerCase();
        if (k.length !== 1) return;
        buf = (buf + k).slice(-seq.length);
        if (buf === seq) {
          buf = '';
          toast('野性档案馆 · 致敬每一位自由观展者');
        }
      });
    }
  };

  /* 每日信标文库 */
  FEATURES.FAITH_POEMS = [
    { id: 'SAV-001', text: '火光熄灭之前，野性的轮廓反而最清晰。' },
    { id: 'SAV-002', text: '真正的档案，不在库房里，而在每一次凝视里。' },
    { id: 'SAV-003', text: '未被驯服的，依然在暗处燃烧。' },
    { id: 'SAV-004', text: '收集不是为了占有，而是为了证明来过。' },
    { id: 'SAV-005', text: '废墟之上，总有一盏自己点亮的灯。' },
    { id: 'SAV-006', text: '风会把脚印带走，但把坚持留给你。' },
    { id: 'SAV-007', text: '把此刻钉在云上，等它变成未来的证词。' },
    { id: 'SAV-008', text: '每个匿名者，都是这座馆的共建者。' },
    { id: 'SAV-009', text: '入口永远敞开，野物自会找到归处。' },
    { id: 'SAV-010', text: '存档即在场：我们因为记录而真实。' },
    { id: 'SAV-011', text: '别急着解释野性，先去感受它的温度。' },
    { id: 'SAV-012', text: '最深的荧光，住在最深的无光处。' },
    { id: 'SAV-013', text: '自由入场的人，眼里都有光。' },
    { id: 'SAV-014', text: '档案会泛黄，但心跳不会。' }
  ];

  document.addEventListener('DOMContentLoaded', () => FEATURES.init());
})();