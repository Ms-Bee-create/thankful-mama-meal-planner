-- Thankful Mama Co Meal Planner — schema
-- Run this in the Supabase SQL Editor (Project > SQL Editor > New query).

create table if not exists public.weekly_plans (
  user_id uuid primary key references auth.users(id) on delete cascade,
  recipe_ids jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.weekly_plans enable row level security;

create policy "read own plan" on public.weekly_plans
  for select using (auth.uid() = user_id);

create policy "write own plan" on public.weekly_plans
  for insert with check (auth.uid() = user_id);

create policy "update own plan" on public.weekly_plans
  for update using (auth.uid() = user_id);

-- Kroger OAuth connection, one row per user. Tokens are only ever
-- read/written by the edge function (service role), never directly
-- by the browser client — RLS below blocks the anon/authenticated
-- roles from touching this table at all.
create table if not exists public.kroger_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  kroger_location_id text,
  created_at timestamptz not null default now()
);

alter table public.kroger_connections enable row level security;
-- No policies defined on purpose: default-deny means only the
-- service-role key (used server-side by the edge function) can
-- read or write this table.
