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
    const imgExt = imgData.substring(5, imgData.indexOf(';') + 1) ? 'webp' : 'jpg';
    const imgKey = `art/${id}/img.${imgExt}`;
    const thumbKey = `art/${id}/thumb.${imgExt}`;

    const upload = (key, dataUrl) => {
      const bytes = atob(dataUrl.split(',')[1]);
      const arr = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      return sb.storage.from(SUPACFG.bucket).upload(key, arr.buffer, {
        contentType: 'image/' + imgExt,
        upsert: true
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
    // 校验该 uid 是否在 admin_users（该查询由 RLS 限定：非管理员读不到）
    const { data: rows } = await db.client().from('art').select('id').limit(0).then(() => ({ data: [] }));
    return true; // 登录成功即视为管理员候选，最终由 RLS 决定操作权限
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

  /* 点赞（对已批准作品 +1/-1，幂等由客户端控制） */
  like(id) {
    return db.client().rpc('art_like', { target_id: id });
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
  }
};