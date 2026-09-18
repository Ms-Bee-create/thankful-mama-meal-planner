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

-- User-added recipes, shown alongside the built-in collection.
create table if not exists public.custom_recipes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  meal_type text not null default 'dinner',
  protein text not null,
  title text not null,
  meta text,
  ingredients jsonb not null default '[]'::jsonb,
  steps jsonb not null default '[]'::jsonb,
  cart_url text,
  created_at timestamptz not null default now()
);

-- Adds the column if this table already exists from before meal_type
-- existed — safe to run even on a fresh table.
alter table public.custom_recipes add column if not exists meal_type text not null default 'dinner';

alter table public.custom_recipes enable row level security;

create policy "read own custom recipes" on public.custom_recipes
  for select using (auth.uid() = user_id);

create policy "write own custom recipes" on public.custom_recipes
  for insert with check (auth.uid() = user_id);

create policy "update own custom recipes" on public.custom_recipes
  for update using (auth.uid() = user_id);

create policy "delete own custom recipes" on public.custom_recipes
  for delete using (auth.uid() = user_id);

-- Pantry staples the user has said they already have — mainly spices
-- and other long-shelf-life items. Marking one skips it on the
-- shopping list for a few weeks instead of adding it every time.
create table if not exists public.pantry_have (
  user_id uuid not null references auth.users(id) on delete cascade,
  item_key text not null,
  marked_at timestamptz not null default now(),
  primary key (user_id, item_key)
);

alter table public.pantry_have enable row level security;

create policy "read own pantry" on public.pantry_have
  for select using (auth.uid() = user_id);

create policy "write own pantry" on public.pantry_have
  for insert with check (auth.uid() = user_id);

create policy "update own pantry" on public.pantry_have
  for update using (auth.uid() = user_id);

create policy "delete own pantry" on public.pantry_have
  for delete using (auth.uid() = user_id);
