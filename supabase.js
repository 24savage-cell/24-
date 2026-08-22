/* ============================================================
   野性档案 SAVAGE ARCHIVE · supabase.js
   云端数据层（Supabase）
   - anon key 为公开只读/受限写入密钥，可安全暴露于浏览器
   - 管理员权限由 RLS（auth.uid 属于 admin_users）控制，前端无法伪造
   - 先审后发：游客投稿 status='pending'，仅管理员可见并批准后公开
   ============================================================ */
'use strict';

const SUPACFG = {
  url: 'https://vqjyhsznnuskxhsmfdxx.supabase.co',
  anonKey: 'sb_publishable_B-IgCqSmZjAc2xgutETSKg_rJE6ADW2',
  bucket: 'savage'
};

let SB = null; // supabase-js 客户端实例
const db = {
  LS_SESSION: 'sa_sb_session', // 管理员会话缓存

  /* 初始化（惰性创建客户端） */
  client() {
    if (!SB) {
      if (typeof window.supabase === 'undefined') {
        throw new Error('Supabase SDK 未加载');
      }
      SB = window.supabase.createClient(SUPACFG.url, SUPACFG.anonKey, {
        auth: {
          storage: localStorage,
          storageKey: db.LS_SESSION,
          autoRefreshToken: true,
          persistSession: true
        }
      });
    }
    return SB;
  },

  /* 公开图片 URL */
  pubUrl(key) {
    return key ? `${SUPACFG.url}/storage/v1/object/public/${SUPACFG.bucket}/${encodeURIComponent(key)}` : '';
  },

  /* ---------- 作品 ---------- */

  /* 游客投稿：写入待审（status=pending） */
  async submit(art, { imgData, thumbData }) {
    const sb = db.client();
    const id = art.id;
    /* 从 dataURL 的 mime 判断扩展名（浏览器压缩当前统一输出 jpeg） */
    const mime = (imgData.match(/^data:(image\/[a-z0-9+.]+)/i) || [])[1] || '';
    const imgExt = mime.includes('webp') ? 'webp' : 'jpg';
    /* 新投稿落 pending/ 隔离区；管理员批准后由 art_approve 流程搬入 art/ 公开区 */
    const imgKey = `pending/${id}/img.${imgExt}`;
    const thumbKey = `pending/${id}/thumb.${imgExt}`;

    const upload = (key, dataUrl) => {
      const bytes = atob(dataUrl.split(',')[1]);
      const arr = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      return sb.storage.from(SUPACFG.bucket).upload(key, arr.buffer, {
        contentType: 'image/' + imgExt,
        upsert: false
      });
    };
    const [imgUp, thumbUp] = await Promise.all([upload(imgKey, imgData), upload(thumbKey, thumbData)]);
    if (imgUp.error) throw new Error(imgUp.error.message || '原图上传失败');
    if (thumbUp.error) throw new Error(thumbUp.error.message || '缩略图上传失败');

    /* 通过 SECURITY DEFINER 函数写入待审（强制 status=pending，规避公开直插并锁死审核） */
    const { error } = await sb.rpc('art_submit', {
      p_id: id,
      p_title: art.title,
      p_desc: art.desc || '',
      p_by: art.by || '匿名观众',
      p_ts: art.ts,
      p_w: art.w,
      p_h: art.h,
      p_img_key: imgKey,
      p_thumb_key: thumbKey
    });
    if (error) throw new Error(error.message || '投稿入库失败');
    return { id, img_key: imgKey, thumb_key: thumbKey };
  },

  /* 公开作品列表（仅已批准）+ 实时订阅（自动显示新批准作品） */
  listApproved() {
    return db.client().from('art')
      .select('*')
      .eq('status', 'approved')
      .order('ts', { ascending: false });
  },

  /* 订阅已批准作品变化 */
  subscribeApproved(cb) {
    return db.client()
      .channel('approved-arts')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'art', filter: 'status=eq.approved' }, cb)
      .subscribe();
  },

  /* ---------- 管理员 ---------- */

  /* 管理员登录（邮箱+密码，RLS 校验身份） */
  async adminLogin(email, password) {
    const { data, error } = await db.client().auth.signInWithPassword({ email, password });
    if (error || !data.session) throw new Error(error ? error.message : '登录失败');
    return data.session;
  },
  async adminLogout() {
    await db.client().auth.signOut();
  },
  adminSession() {
    return db.client().auth.getSession();
  },
  async isAdmin() {
    const { data } = await db.adminSession();
    if (!data.session) return false;
    // 真正校验：该 uid 是否在 admin_users（RLS 策略 admin_read_self 保证只能查到自己的记录）
    const { data: rows, error } = await db.client()
      .from('admin_users')
      .select('uid')
      .eq('uid', data.session.user.id)
      .limit(1);
    if (error) return false;
    return !!(rows && rows.length);
  },

  /* 管理员读取全部（含待审） */
  listAll() {
    return db.client().from('art').select('*').order('ts', { ascending: false });
  },
  listPending() {
    return db.client().from('art').select('*').eq('status', 'pending').order('ts', { ascending: false });
  },

  /* 管理员更新状态/字段 */
  adminUpdate(id, patch) {
    return db.client().from('art').update(patch).eq('id', id);
  },

  /* 管理员删除作品与图片 */
  async adminRemove(id, { img_key, thumb_key }) {
    const keys = [img_key, thumb_key].filter(Boolean);
    if (keys.length) await db.client().storage.from(SUPACFG.bucket).remove(keys);
    const { error } = await db.client().from('art').delete().eq('id', id);
    if (error) throw new Error(error.message);
  },

  /* 点赞（服务端幂等：登录按 uid、匿名按 session，且全局限流） */
  like(id) {
    return db.client().rpc('art_like', { target_id: id, p_liker: db.sessionId() });
  },

  /* ---------- 聊天室 ---------- */

  /* 拉取最近消息（倒序取 N 条，再按 id 正序展示） */
  async chatRecent(count = 50) {
    const { data, error } = await db.client()
      .from('chat')
      .select('id,body,author,kind,ts')
      .order('id', { ascending: false })
      .limit(count);
    if (error) throw new Error(error.message);
    return (data || []).reverse();
  },

  /* 发送消息：走 SECURITY DEFINER 函数（含服务端限流） */
  async chatSend(body, author, kind, sessionKey) {
    const { data, error } = await db.client().rpc('chat_send', {
      p_body: body, p_author: author, p_kind: kind, p_session_key: sessionKey
    });
    if (error) {
      const code = error.message || '';
      if (/RATE_LIMIT/.test(code)) throw new Error('发送太频繁，请稍候再试');
      throw new Error('消息发送失败');
    }
    return data;
  },

  /* 订阅新消息（实时） */
  subscribeChat(cb) {
    return db.client()
      .channel('chat-room')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat' }, cb)
      .subscribe();
  },

  /* ---------- 管理后台 2.0 ---------- */

  /* 稳定访客标识（localStorage，用于去重统计） */
  sessionId() {
    let s = '';
    try { s = localStorage.getItem('sa_sid') || ''; } catch (e) {}
    if (!s) {
      s = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      try { localStorage.setItem('sa_sid', s); } catch (e) {}
    }
    return s;
  },

  /* 页面访问埋点：返回 {banned} 表示该 IP 是否被封 */
  async trackVisit() {
    let ip = null;
    try {
      const cached = JSON.parse(localStorage.getItem('sa_ip') || 'null');
      if (cached && Date.now() - cached.t < 86400000) ip = cached.ip;
      else {
        const r = await fetch('https://api.ipify.org?format=json', { cache: 'no-store' });
        const j = await r.json();
        if (j && j.ip) { ip = j.ip; localStorage.setItem('sa_ip', JSON.stringify({ ip, t: Date.now() })); }
      }
    } catch (e) {}
    try {
      const { data } = await db.client().rpc('track_visit', {
        p_ip: ip,
        p_ua: (navigator.userAgent || '').slice(0, 200),
        p_path: (location.pathname || '').slice(0, 100),
        p_ref: (document.referrer || '').slice(0, 200) || null,
        p_session: db.sessionId()
      });
      return data || null;
    } catch (e) { return null; }
  },

  /* 管理员操作审计 */
  async logAction(action, detail) {
    try { await db.client().rpc('audit_log', { p_action: action, p_detail: detail || null }); }
    catch (e) {}
  },

  /* 访客统计（管理员） */
  async mgrStats() {
    const { data } = await db.client().rpc('visits_stats');
    return data || null;
  },
  /* 最近访问（管理员） */
  async mgrVisits(limit) {
    const { data, error } = await db.client().rpc('visits_recent', { p_limit: limit || 50 });
    if (error) throw new Error(error.message);
    return data || [];
  },
  /* 最近审计（管理员） */
  async mgrAudit(limit) {
    const { data, error } = await db.client().rpc('audit_recent', { p_limit: limit || 50 });
    if (error) throw new Error(error.message);
    return data || [];
  },
  /* 封禁列表（管理员） */
  async mgrBans() {
    const { data, error } = await db.client().rpc('bans_list');
    if (error) throw new Error(error.message);
    return data || [];
  },
  /* 添加封禁（管理员） */
  async mgrBanAdd(type, value, reason, expiresTs) {
    const { data, error } = await db.client().rpc('ban_add', { p_type: type, p_value: value, p_reason: reason || null, p_expires_ts: expiresTs || null });
    if (error) throw new Error(error.message);
    return data;
  },
  /* 移除封禁（管理员） */
  async mgrBanRemove(id) {
    const { error } = await db.client().rpc('ban_remove', { p_id: id });
    if (error) throw new Error(error.message);
  },
  /* 用户列表（管理员） */
  async mgrUsers() {
    const { data, error } = await db.client().rpc('users_list');
    if (error) throw new Error(error.message);
    return data || [];
  },
  /* 封禁用户（管理员） */
  async mgrUserBan(email, untilTs) {
    const { error } = await db.client().rpc('user_ban', { p_email: email, p_until_ts: untilTs || null });
    if (error) throw new Error(error.message);
  },
  /* 解封用户（管理员） */
  async mgrUserUnban(email) {
    const { error } = await db.client().rpc('user_unban', { p_email: email });
    if (error) throw new Error(error.message);
  }
};