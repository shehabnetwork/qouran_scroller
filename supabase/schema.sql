-- Run this SQL in the Supabase SQL editor to set up the database schema.

-- ──────────────────────────────────────────────
-- Tables
-- ──────────────────────────────────────────────

create table public.user_preferences (
  user_id     uuid    primary key references auth.users(id) on delete cascade,
  mode        text    not null default 'all',
  from_juz    int     not null default 1,
  to_juz      int     not null default 30,
  from_surah  int     not null default 1,
  to_surah    int     not null default 114,
  ayah        int     not null default 1
);

create table public.reading_history (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users(id) on delete cascade,
  name        text        not null,
  start_index int         not null,
  end_index   int         not null,
  created_at  timestamptz not null default now()
);

create index reading_history_user_id_idx on public.reading_history(user_id);

-- ──────────────────────────────────────────────
-- Row Level Security
-- ──────────────────────────────────────────────

alter table public.user_preferences enable row level security;
alter table public.reading_history   enable row level security;

-- user_preferences policies
create policy "select own preferences"
  on public.user_preferences for select
  using (auth.uid() = user_id);

create policy "insert own preferences"
  on public.user_preferences for insert
  with check (auth.uid() = user_id);

create policy "update own preferences"
  on public.user_preferences for update
  using (auth.uid() = user_id);

-- reading_history policies
create policy "select own readings"
  on public.reading_history for select
  using (auth.uid() = user_id);

create policy "insert own readings"
  on public.reading_history for insert
  with check (auth.uid() = user_id);

create policy "delete own readings"
  on public.reading_history for delete
  using (auth.uid() = user_id);
