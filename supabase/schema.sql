-- =====================================================================
-- Team Tasks · مهام الفريق
-- Database schema for Supabase (PostgreSQL).
-- Run this whole file once in: Supabase Dashboard → SQL Editor → New query.
-- Safe to re-run: it drops and recreates functions, triggers and policies,
-- but never drops tables or data.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

-- People who can use the app. The manager adds employees by their
-- company e-mail; signing in with Google under that e-mail links them.
create table if not exists public.members (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (char_length(name) between 1 and 80),
  email         text not null unique check (email = lower(email)),
  role          text not null default 'employee' check (role in ('manager','employee')),
  active        boolean not null default true,
  sort_order    int not null default 0,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now()
);

create table if not exists public.tasks (
  id                  uuid primary key default gen_random_uuid(),
  member_id           uuid not null references public.members(id) on delete restrict,
  title               text not null check (char_length(title) between 1 and 160),
  details             text not null default '' check (char_length(details) <= 4000),
  source              text not null default 'manager' check (source in ('manager','self')),
  assigned_on         date not null default current_date,
  due                 date,
  priority            text not null default 'normal' check (priority in ('normal','urgent')),
  status              text not null default 'waiting' check (status in ('waiting','doing','done')),
  -- challenge
  challenge           text not null default '' check (char_length(challenge) <= 4000),
  challenge_at        timestamptz,
  challenge_resolved  boolean not null default false,
  escalated           boolean not null default false,      -- sent to the manager
  escalated_at        timestamptz,
  resolved_role       text check (resolved_role in ('manager','employee')),
  resolved_at         timestamptz,
  resolution          text not null default '' check (char_length(resolution) <= 4000),
  resolution_ack      boolean not null default true,       -- employee saw the manager's solution
  done_at             timestamptz,
  -- comment summary (kept by trigger)
  comment_count       int not null default 0,
  last_comment_role   text check (last_comment_role in ('manager','employee')),
  -- audit
  created_by          uuid references public.members(id) on delete set null,
  created_role        text not null default 'employee' check (created_role in ('manager','employee')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists tasks_member_idx on public.tasks(member_id);
create index if not exists tasks_status_idx on public.tasks(status, done_at);

create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.tasks(id) on delete cascade,
  author_id   uuid references public.members(id) on delete set null,
  role        text not null check (role in ('manager','employee')),
  body        text not null check (char_length(body) between 1 and 4000),
  created_at  timestamptz not null default now()
);
create index if not exists comments_task_idx on public.comments(task_id, created_at);

create table if not exists public.task_log (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.tasks(id) on delete cascade,
  actor_id    uuid references public.members(id) on delete set null,
  role        text not null check (role in ('manager','employee')),
  text        text not null check (char_length(text) between 1 and 600),
  created_at  timestamptz not null default now()
);
create index if not exists task_log_task_idx on public.task_log(task_id, created_at);

-- ---------------------------------------------------------------------
-- Who is signed in?  (security definer so RLS policies can call them)
-- ---------------------------------------------------------------------

create or replace function public.my_member_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.members
  where email = lower(coalesce(auth.jwt() ->> 'email', '')) and active
  limit 1
$$;

create or replace function public.is_manager() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.members
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
      and active and role = 'manager'
  )
$$;

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select case when public.is_manager() then 'manager' else 'employee' end
$$;

-- Lets a signed-in member record their own visit, so the manager can
-- see who has joined. Returns the member row (or nothing if not added).
create or replace function public.touch_me()
returns setof public.members
language sql volatile security definer set search_path = public as $$
  update public.members set last_seen_at = now()
  where id = public.my_member_id()
  returning *
$$;

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------

create or replace function public.tasks_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.created_by   := public.my_member_id();
    new.created_role := public.my_role();
    new.comment_count := 0;
    new.last_comment_role := null;
  else
    new.created_by   := old.created_by;
    new.created_role := old.created_role;
    new.created_at   := old.created_at;
    -- comment summary is maintained only by the comments trigger
    if current_setting('team_tasks.from_comment', true) is distinct from 'on' then
      new.comment_count := old.comment_count;
      new.last_comment_role := old.last_comment_role;
    end if;
  end if;
  -- only the manager can mark a challenge as "solved by the manager"
  if new.resolved_role = 'manager'
     and (tg_op = 'INSERT' or old.resolved_role is distinct from 'manager'
          or old.resolved_at is distinct from new.resolved_at
          or old.resolution is distinct from new.resolution)
     and not public.is_manager() then
    raise exception 'only the manager can resolve on behalf of the manager';
  end if;
  return new;
end $$;

drop trigger if exists tasks_guard on public.tasks;
create trigger tasks_guard before insert or update on public.tasks
for each row execute function public.tasks_guard();

create or replace function public.comments_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('team_tasks.from_comment', 'on', true);
  update public.tasks
     set comment_count = comment_count + 1,
         last_comment_role = new.role
   where id = new.task_id;
  perform set_config('team_tasks.from_comment', 'off', true);
  return new;
end $$;

drop trigger if exists comments_after_insert on public.comments;
create trigger comments_after_insert after insert on public.comments
for each row execute function public.comments_after_insert();

-- ---------------------------------------------------------------------
-- Row level security: employees see only their own tasks; the manager
-- sees everything. Nothing is readable without signing in.
-- ---------------------------------------------------------------------

alter table public.members  enable row level security;
alter table public.tasks    enable row level security;
alter table public.comments enable row level security;
alter table public.task_log enable row level security;

revoke all on public.members, public.tasks, public.comments, public.task_log from anon;
grant select, insert, update, delete on public.members, public.tasks to authenticated;
grant select, insert on public.comments, public.task_log to authenticated;
grant delete on public.comments to authenticated;

-- members
drop policy if exists members_select on public.members;
drop policy if exists members_manage on public.members;
create policy members_select on public.members for select to authenticated
  using (public.is_manager() or id = public.my_member_id());
create policy members_manage on public.members for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

-- tasks
drop policy if exists tasks_select on public.tasks;
drop policy if exists tasks_insert on public.tasks;
drop policy if exists tasks_update on public.tasks;
drop policy if exists tasks_delete on public.tasks;
create policy tasks_select on public.tasks for select to authenticated
  using (public.is_manager() or member_id = public.my_member_id());
create policy tasks_insert on public.tasks for insert to authenticated
  with check (public.is_manager() or member_id = public.my_member_id());
create policy tasks_update on public.tasks for update to authenticated
  using (public.is_manager() or member_id = public.my_member_id())
  with check (public.is_manager() or member_id = public.my_member_id());
create policy tasks_delete on public.tasks for delete to authenticated
  using (public.is_manager() or member_id = public.my_member_id());

-- comments
drop policy if exists comments_select on public.comments;
drop policy if exists comments_insert on public.comments;
drop policy if exists comments_delete on public.comments;
create policy comments_select on public.comments for select to authenticated
  using (exists (select 1 from public.tasks t where t.id = task_id
                 and (public.is_manager() or t.member_id = public.my_member_id())));
create policy comments_insert on public.comments for insert to authenticated
  with check (author_id = public.my_member_id() and role = public.my_role()
              and exists (select 1 from public.tasks t where t.id = task_id
                          and (public.is_manager() or t.member_id = public.my_member_id())));
create policy comments_delete on public.comments for delete to authenticated
  using (public.is_manager());

-- task log
drop policy if exists task_log_select on public.task_log;
drop policy if exists task_log_insert on public.task_log;
create policy task_log_select on public.task_log for select to authenticated
  using (exists (select 1 from public.tasks t where t.id = task_id
                 and (public.is_manager() or t.member_id = public.my_member_id())));
create policy task_log_insert on public.task_log for insert to authenticated
  with check (actor_id = public.my_member_id() and role = public.my_role()
              and exists (select 1 from public.tasks t where t.id = task_id
                          and (public.is_manager() or t.member_id = public.my_member_id())));

grant execute on function public.my_member_id(), public.is_manager(), public.my_role(), public.touch_me() to authenticated;
revoke execute on function public.touch_me() from anon;

-- ---------------------------------------------------------------------
-- Live updates (Supabase Realtime respects the policies above)
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['members','tasks','comments','task_log'] loop
      if not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- First manager (edit and run once, separately):
--   insert into public.members (name, email, role)
--   values ('اسمك', 'your.name@company.com', 'manager');
-- ---------------------------------------------------------------------
