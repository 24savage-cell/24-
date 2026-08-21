-- ============================================================
-- 野性档案 SAVAGE ARCHIVE · schema migration
-- 目标项目: vqjyhsznnuskxhsmfdxx
-- 在新项目 SQL Editor 中一次性执行即可。
-- 说明：service_role JWT 无法通过 REST 执行 DDL，建表必须走 SQL Editor。
-- ============================================================

-- ---------- 1) 存储桶 ----------
insert into storage.buckets (id, name, public)
values ('savage', 'savage', true)
on conflict (id) do nothing;

-- ---------- 2) art 表（作品/投稿） ----------
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
  status     text not null default 'pending',   -- pending | approved | rejected
  img_key    text,
  thumb_key  text
);

-- ---------- 3) chat 表（聊天室） ----------
create table if not exists public.chat (
  id          bigserial primary key,
  body        text not null,
  author      text not null,
  kind        text not null default 'anon',
  session_key text,
  ts          bigint not null default ((extract(epoch from now()) * 1000))::bigint
);

-- ---------- 4) admin_users 表（管理员白名单） ----------
create table if not exists public.admin_users (
  uid   uuid primary key,
  email text
);

-- ---------- 5) 行级安全 ----------
alter table public.art         enable row level security;
alter table public.chat        enable row level security;
alter table public.admin_users enable row level security;

-- art：公开仅可读已批准；管理员可读全部
drop policy if exists art_select_public on public.art;
create policy art_select_public on public.art
  for select to anon, authenticated
  using (status = 'approved');

drop policy if exists art_select_admin on public.art;
create policy art_select_admin on public.art
  for select to authenticated
  using (exists (select 1 from public.admin_users where uid = auth.uid()));

-- chat：公开可读全部；写入走 security definer 函数
drop policy if exists chat_select_all on public.chat;
create policy chat_select_all on public.chat
  for select to anon, authenticated
  using (true);

-- admin_users：仅本人可读自己（RLS 防越权）
drop policy if exists admin_read_self on public.admin_users;
create policy admin_read_self on public.admin_users
  for select to authenticated
  using (uid = auth.uid());

-- ---------- 6) 函数：投稿（强制 pending，先审后发） ----------
create or replace function public.art_submit(
  p_id text, p_title text, p_desc text, p_by text,
  p_ts bigint, p_w int, p_h int,
  p_img_key text, p_thumb_key text
) returns text
language plpgsql security definer
set search_path = public
as $$
declare v_no text;
begin
  v_no := lpad((select coalesce(max(cast(no as int)),0) + 1 from public.art), 3, '0');
  insert into public.art (id, no, title, "desc", by, ts, w, h, status, img_key, thumb_key)
  values (p_id, v_no, coalesce(p_title,''), coalesce(p_desc,''),
          coalesce(p_by,'匿名观众'), p_ts, p_w, p_h,
          'pending', p_img_key, p_thumb_key);
  return p_id;
end $$;
grant execute on function public.art_submit(text,text,text,text,bigint,int,int,text,text) to anon, authenticated;

-- ---------- 7) 函数：点赞 ----------
create or replace function public.art_like(target_id text)
returns int
language plpgsql security definer
set search_path = public
as $$
declare v_likes int;
begin
  update public.art set likes = likes + 1
  where id = target_id and status = 'approved'
  returning likes into v_likes;
  return coalesce(v_likes, 0);
end $$;
grant execute on function public.art_like(text) to anon, authenticated;

-- ---------- 8) 函数：聊天发送（服务端限流：3秒1条） ----------
create or replace function public.chat_send(
  p_body text, p_author text, p_kind text default 'anon', p_session_key text default null
) returns bigint
language plpgsql security definer
set search_path = public
as $$
declare v_id bigint; v_cnt int; v_min bigint;
begin
  if p_body is null or length(btrim(p_body)) = 0 then
    raise exception 'EMPTY';
  end if;
  if length(p_body) > 300 then
    p_body := left(p_body, 300);
  end if;
  v_min := ((extract(epoch from now()) * 1000))::bigint - 3000;
  if p_session_key is null then
    select count(*) into v_cnt from public.chat where ts > v_min;
  else
    select count(*) into v_cnt from public.chat where ts > v_min and session_key = p_session_key;
  end if;
  if v_cnt >= 3 then
    raise exception 'RATE_LIMIT 发送太频繁，请稍候再试';
  end if;
  insert into public.chat (body, author, kind, session_key, ts)
  values (btrim(p_body), coalesce(p_author,'匿名'), p_kind,
          p_session_key, ((extract(epoch from now()) * 1000))::bigint)
  returning id into v_id;
  return v_id;
end $$;
grant execute on function public.chat_send(text,text,text,text) to anon, authenticated;