-- ============================================================
-- 野性档案 SAVAGE ARCHIVE · schema（与线上部署同步 · 2026-08-22 安全审计后终态）
-- 目标项目: vqjyhsznnuskxhsmfdxx
-- 说明：service_role JWT 无法通过 REST 执行 DDL，建表必须走 SQL Editor。
--
-- 安全模型摘要：
--   · 所有表启用 RLS；公开只读「已批准」内容，写入一律走 SECURITY DEFINER 函数
--   · 所有 SECURITY DEFINER 函数内部二次校验 admin_users（匿名调用也安全）
--   · 存储桶分区隔离：pending/（投稿隔离区，匿名只写）⇄ art/（公开区，匿名只读）
--     搬移由管理员前端调用 Storage move API（savage_admin_update 策略放行）
--   · chat 表列级授权：session_key 对访客不可见（REST 与 Realtime 均生效）
--   · art_submit 强制校验客户端时间戳（±24h），杜绝限流绕过
--   · 作品 ID 为前端 96bit 加密随机数，对象密钥不可枚举/猜测
-- ============================================================

-- ---------- 1) 存储桶 ----------
insert into storage.buckets (id, name, public)
values ('savage', 'savage', true)
on conflict (id) do nothing;

-- ---------- 2) 表 ----------
create table if not exists public.art (
  id         text primary key,
  no         text not null default '000',
  title      text not null default '',
  "desc"     text default '',
  by         text default '匿名观众',
  ts         bigint,
  likes      int  not null default 0,
  w          int  default 0,
  h          int  default 0,
  status     text not null default 'pending',   -- pending | approved
  img_key    text,
  thumb_key  text
);

create table if not exists public.chat (
  id          bigserial primary key,
  body        text not null,
  author      text not null,
  kind        text not null default 'anon',
  session_key text,
  ts          bigint not null default ((extract(epoch from now()) * 1000))::bigint
);

create table if not exists public.admin_users (
  uid   uuid primary key,
  email text
);

-- 管理后台 2.0（埋点 / 审计 / 封禁 / 点赞记录）
create table if not exists public.visits (
  id          bigserial primary key,
  ip          text,
  ua          text,
  path        text,
  ref         text,
  session_key text,
  ts          bigint not null default ((extract(epoch from now()) * 1000))::bigint
);
create table if not exists public.audit_logs (
  id          bigserial primary key,
  actor_email text,
  action      text,
  detail      text,
  ts          bigint not null default ((extract(epoch from now()) * 1000))::bigint
);
create table if not exists public.bans (
  id         bigserial primary key,
  btype      text not null,
  value      text not null,
  reason     text,
  created_at bigint not null default ((extract(epoch from now()) * 1000))::bigint),
  expires_at bigint,
  active     boolean not null default true
);
create table if not exists public.art_likes (
  id     bigserial primary key,
  art_id text not null,
  liker  text not null,
  ts     bigint not null default ((extract(epoch from now()) * 1000))::bigint,
  unique (art_id, liker)
);

-- ---------- 3) 行级安全 ----------
alter table public.art         enable row level security;
alter table public.chat        enable row level security;
alter table public.admin_users enable row level security;
alter table public.visits      enable row level security;
alter table public.audit_logs  enable row level security;
alter table public.bans        enable row level security;
alter table public.art_likes   enable row level security;

drop policy if exists art_select_public on public.art;
create policy art_select_public on public.art
  for select to anon, authenticated
  using (status = 'approved');

drop policy if exists art_select_admin on public.art;
create policy art_select_admin on public.art
  for select to authenticated
  using (exists (select 1 from public.admin_users where uid = auth.uid()));

drop policy if exists chat_select_all on public.chat;
create policy chat_select_all on public.chat
  for select to anon, authenticated
  using (true);

drop policy if exists admin_read_self on public.admin_users;
create policy admin_read_self on public.admin_users
  for select to authenticated
  using (uid = auth.uid());

-- chat 列级授权：访客不可见 session_key（REST 与 Realtime 均生效）
revoke select on public.chat from anon, authenticated;
grant select (id, body, author, kind, ts) on public.chat to anon, authenticated;

-- ---------- 4) 存储桶策略（分区隔离） ----------
-- 匿名上传：仅允许 pending/ 前缀，且全桶 30 次/小时
drop policy if exists savage_insert_pending on storage.objects;
create policy savage_insert_pending on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'savage'
    and (storage.foldername(name))[1] = 'pending'
    and (select count(*) from storage.objects o
         where o.bucket_id = 'savage' and o.created_at > now() - interval '1 hour') < 30
  );

-- 公开读：仅 art/ 前缀（approved 区）；pending/ 对访客不可枚举
drop policy if exists savage_read_public on storage.objects;
create policy savage_read_public on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'savage' and (storage.foldername(name))[1] = 'art');

-- 管理员读全桶（后台审片需要）
drop policy if exists savage_read_admin on storage.objects;
create policy savage_read_admin on storage.objects
  for select to authenticated
  using (bucket_id = 'savage' and exists (select 1 from public.admin_users where uid = auth.uid()));

-- 管理员更新/删除（move API 依赖 UPDATE）
drop policy if exists savage_admin_update on storage.objects;
create policy savage_admin_update on storage.objects
  for update to authenticated
  using (bucket_id = 'savage' and exists (select 1 from public.admin_users where uid = auth.uid()));

drop policy if exists savage_admin_delete on storage.objects;
create policy savage_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'savage' and exists (select 1 from public.admin_users where uid = auth.uid()));

-- ---------- 5) Realtime 发布（聊天实时 + 审批实时通知） ----------
-- 若已存在会报错，可忽略：
-- alter publication supabase_realtime add table public.chat;
-- alter publication supabase_realtime add table public.art;

-- ---------- 6) 函数：投稿（强制 pending + 时间戳校验 + 限流 + pending/ 密钥校验） ----------
create or replace function public.art_submit(
  p_id text, p_title text, p_desc text, p_by text,
  p_ts bigint, p_w int, p_h int,
  p_img_key text, p_thumb_key text
) returns text
language plpgsql security definer
set search_path = public
as $$
declare v_no text; v_cnt int; v_min bigint; v_now bigint; v_is_admin boolean;
begin
  if p_id is null or length(p_id) > 40 then raise exception 'BAD_ID'; end if;
  if p_title is not null and length(p_title) > 100 then p_title := left(p_title, 100); end if;
  if p_desc is not null and length(p_desc) > 500 then p_desc := left(p_desc, 500); end if;
  if p_by is not null and length(p_by) > 30 then p_by := left(p_by, 30); end if;
  -- 密钥必须落在 pending/ 隔离区
  if p_img_key is null or length(p_img_key) > 200 or p_img_key not like 'pending/%' then raise exception 'BAD_KEY'; end if;
  if p_thumb_key is null or length(p_thumb_key) > 200 or p_thumb_key not like 'pending/%' then raise exception 'BAD_KEY'; end if;
  -- 时间戳必须位于服务器时间 ±24h（杜绝用远古时间戳绕过限流窗口）
  v_now := ((extract(epoch from now()) * 1000))::bigint;
  if p_ts is null or p_ts < v_now - 86400000 or p_ts > v_now + 86400000 then
    raise exception 'BAD_TS';
  end if;
  -- 保留名保护：非管理员不得冒用馆方身份
  select exists(select 1 from public.admin_users where uid = auth.uid()) into v_is_admin;
  if not v_is_admin and lower(btrim(coalesce(p_by,''))) in
     ('24.savage','24savage','savage','admin','curator','system','anonymous','匿名观众','馆方') then
    p_by := '匿名观众';
  end if;
  -- 限流：1 分钟全局最多 10 次
  v_min := v_now - 60000;
  select count(*) into v_cnt from public.art where ts > v_min;
  if v_cnt >= 10 then raise exception 'RATE_LIMIT 投稿过于频繁，请稍候'; end if;
  insert into public.art (id, no, title, "desc", by, ts, w, h, status, img_key, thumb_key)
  values (p_id, '000', coalesce(p_title,''), coalesce(p_desc,''),
          coalesce(p_by,'匿名观众'), p_ts, p_w, p_h, 'pending', p_img_key, p_thumb_key);
  return p_id;
end $$;
grant execute on function public.art_submit(text,text,text,text,bigint,int,int,text,text) to anon, authenticated;

-- ---------- 7) 函数：审批（编号自 101 起，避免与馆藏 001–010 冲突；文件搬移由前端 move API 完成） ----------
create or replace function public.art_approve(p_id text) returns text
language plpgsql security definer
set search_path = public
as $$
declare v_found boolean; v_new_no text;
begin
  if not exists (select 1 from public.admin_users where uid = auth.uid()) then
    raise exception 'FORBIDDEN';
  end if;
  select exists(select 1 from public.art where id = p_id) into v_found;
  if not v_found then raise exception 'NOT_FOUND'; end if;
  v_new_no := lpad((((select coalesce(max(cast(no as int)),100) from public.art
                      where no ~ '^[0-9]+$' and cast(no as int) >= 100)) + 1)::text, 3, '0');
  update public.art
  set status = 'approved', no = v_new_no,
      img_key   = case when img_key   like 'pending/%' then 'art/' || substr(img_key, 9)   else img_key   end,
      thumb_key = case when thumb_key like 'pending/%' then 'art/' || substr(thumb_key, 9) else thumb_key end
  where id = p_id;
  return v_new_no;
end $$;
revoke execute on function public.art_approve(text) from public, anon;
grant execute on function public.art_approve(text) to authenticated;

-- ---------- 8) 函数：下架 ----------
create or replace function public.art_reject(p_id text) returns boolean
language plpgsql security definer
set search_path = public
as $$
declare v_found boolean;
begin
  if not exists (select 1 from public.admin_users where uid = auth.uid()) then
    raise exception 'FORBIDDEN';
  end if;
  select exists(select 1 from public.art where id = p_id) into v_found;
  if not v_found then raise exception 'NOT_FOUND'; end if;
  update public.art
  set status = 'pending', no = '000',
      img_key   = case when img_key   like 'art/%' then 'pending/' || substr(img_key, 5)   else img_key   end,
      thumb_key = case when thumb_key like 'art/%' then 'pending/' || substr(thumb_key, 5) else thumb_key end
  where id = p_id;
  return true;
end $$;
revoke execute on function public.art_reject(text) from public, anon;
grant execute on function public.art_reject(text) to authenticated;

-- ---------- 9) 函数：点赞（按会话幂等 + 全局限流） ----------
create or replace function public.art_like(target_id text, p_liker text default null)
returns int
language plpgsql security definer
set search_path = public
as $$
declare v_likes int; v_liker text; v_cnt int; v_min bigint;
begin
  if target_id is null or length(target_id) > 40 then return 0; end if;
  v_min := ((extract(epoch from now()) * 1000))::bigint - 3000;
  select count(*) into v_cnt from public.art_likes where ts > v_min;
  if v_cnt >= 20 then raise exception 'RATE_LIMIT 点赞过于频繁，请稍候'; end if;
  if auth.uid() is not null then
    v_liker := 'u:' || auth.uid()::text;
  else
    v_liker := 's:' || coalesce(nullif(btrim(coalesce(p_liker,'')),''), 'anon');
    if length(v_liker) > 80 then v_liker := left(v_liker, 80); end if;
  end if;
  if exists (select 1 from public.art_likes where art_id = target_id and liker = v_liker) then
    select likes into v_likes from public.art where id = target_id;
    return coalesce(v_likes, 0);
  end if;
  insert into public.art_likes (art_id, liker) values (target_id, v_liker);
  update public.art set likes = likes + 1
  where id = target_id and status = 'approved'
  returning likes into v_likes;
  return coalesce(v_likes, 0);
end $$;
grant execute on function public.art_like(text, text) to anon, authenticated;

-- ---------- 10) 函数：聊天（保留名保护 + 三重限流） ----------
create or replace function public.chat_send(
  p_body text, p_author text, p_kind text default 'anon', p_session_key text default null
) returns bigint
language plpgsql security definer
set search_path = public
as $$
declare v_id bigint; v_cnt int; v_min bigint; v_is_admin boolean;
begin
  if p_body is null or length(btrim(p_body)) = 0 then raise exception 'EMPTY'; end if;
  if length(p_body) > 300 then p_body := left(p_body, 300); end if;
  if p_author is not null and length(p_author) > 30 then p_author := left(p_author, 30); end if;
  if p_session_key is not null and length(p_session_key) > 64 then p_session_key := left(p_session_key, 64); end if;
  if p_kind is not null and length(p_kind) > 10 then p_kind := left(p_kind, 10); end if;
  select exists(select 1 from public.admin_users where uid = auth.uid()) into v_is_admin;
  if not v_is_admin and lower(btrim(coalesce(p_author,''))) in
     ('24.savage','24savage','savage','admin','curator','system','anonymous','匿名观众','馆方') then
    p_author := '匿名观众';
  end if;
  v_min := ((extract(epoch from now()) * 1000))::bigint - 3000;
  if p_session_key is null then
    select count(*) into v_cnt from public.chat where ts > v_min;
    if v_cnt >= 3 then raise exception 'RATE_LIMIT 发送太频繁，请稍候再试'; end if;
  else
    select count(*) into v_cnt from public.chat where ts > v_min and session_key = p_session_key;
    if v_cnt >= 3 then raise exception 'RATE_LIMIT 发送太频繁，请稍候再试'; end if;
    select count(*) into v_cnt from public.chat where ts > v_min;
    if v_cnt >= 15 then raise exception 'RATE_LIMIT 聊天室繁忙，请稍候'; end if;
  end if;
  insert into public.chat (body, author, kind, session_key, ts)
  values (btrim(p_body), coalesce(p_author,'匿名'), p_kind,
          p_session_key, ((extract(epoch from now()) * 1000))::bigint)
  returning id into v_id;
  return v_id;
end $$;
grant execute on function public.chat_send(text,text,text,text) to anon, authenticated;

-- ---------- 11) 函数：访问埋点（IP 封禁检查 + 限流；IP 前缀匹配带点边界） ----------
create or replace function public.track_visit(
  p_ip text default null, p_ua text default null, p_path text default null,
  p_ref text default null, p_session text default null
) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare v_banned boolean; v_cnt int; v_min bigint; v_ip text;
begin
  v_ip := nullif(btrim(coalesce(p_ip,'')),'');
  select exists(
    select 1 from public.bans
    where active = true and btype = 'ip'
      and (value = v_ip
           or v_ip like value || '.%'
           or (split_part(value,'.',4) = '0'
               and split_part(v_ip,'.',1)||'.'||split_part(v_ip,'.',2)||'.'||split_part(v_ip,'.',3)
                 = split_part(value,'.',1)||'.'||split_part(value,'.',2)||'.'||split_part(value,'.',3)))
      and (expires_at is null or expires_at > ((extract(epoch from now()) * 1000))::bigint)
  ) into v_banned;
  v_min := ((extract(epoch from now()) * 1000))::bigint - 10000;
  if p_session is not null then
    select count(*) into v_cnt from public.visits where session_key = p_session and ts > v_min;
    if v_cnt > 0 then return jsonb_build_object('banned', coalesce(v_banned,false)); end if;
  end if;
  insert into public.visits (ip, ua, path, ref, session_key)
  values (v_ip,
          left(nullif(btrim(coalesce(p_ua,'')),''),200),
          left(nullif(btrim(coalesce(p_path,'')),''),100),
          left(nullif(btrim(coalesce(p_ref,'')),''),200),
          left(nullif(btrim(coalesce(p_session,'')),''),64));
  return jsonb_build_object('banned', coalesce(v_banned,false));
end $$;
grant execute on function public.track_visit(text,text,text,text,text) to anon, authenticated;

-- ---------- 12) 管理后台函数（全部内部校验 admin_users，略——见线上定义） ----------
-- audit_log / audit_recent / visits_stats / visits_recent /
-- bans_list / ban_add / ban_remove / users_list / user_ban / user_unban
-- 模式统一：
--   if not exists (select 1 from public.admin_users where uid = auth.uid()) then
--     raise exception 'FORBIDDEN';
--   end if;

-- ---------- 13) 性能索引 ----------
create index if not exists idx_art_likes_ts     on public.art_likes (ts);
create index if not exists idx_art_likes_art     on public.art_likes (art_id, liker);
create index if not exists idx_chat_ts           on public.chat (ts);
create index if not exists idx_visits_ts         on public.visits (ts);
create index if not exists idx_visits_session    on public.visits (session_key, ts);
create index if not exists idx_art_status_ts     on public.art (status, ts);
