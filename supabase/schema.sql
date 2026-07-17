-- Every Street — Phase 1 schema
-- Run this in Supabase: SQL Editor → New query → paste → Run

create extension if not exists postgis;

-- Cached areas (shared across all users)
create table if not exists areas (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  label text not null,
  bbox jsonb not null,           -- [south, north, west, east]
  center jsonb not null,         -- [lat, lon]
  street_count int not null default 0,
  total_length_m real not null default 0,
  created_at timestamptz not null default now()
);

-- Street segments per area (shared cache)
create table if not exists streets (
  id text primary key,           -- '<area_slug>:<edge_id>'
  area_id uuid not null references areas(id) on delete cascade,
  edge_id text not null,
  name text not null default '',
  length_m real not null,
  from_node bigint not null,
  to_node bigint not null,
  coords jsonb not null          -- [[lat,lon], ...]
);
create index if not exists streets_area_idx on streets(area_id);

-- Per-user street coverage
create table if not exists covered (
  user_id uuid not null references auth.users(id) on delete cascade,
  street_id text not null references streets(id) on delete cascade,
  times int not null default 1,
  updated_at timestamptz not null default now(),
  primary key (user_id, street_id)
);

-- Completed runs
create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  area_id uuid not null references areas(id) on delete cascade,
  distance_m real not null,
  new_distance_m real not null,
  coords jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists runs_user_idx on runs(user_id, created_at desc);

-- Row-level security: users can only see their own runs/coverage.
-- (The server uses the service-role key, which bypasses RLS; these
-- policies protect against any direct client access.)
alter table runs enable row level security;
alter table covered enable row level security;
alter table areas enable row level security;
alter table streets enable row level security;

create policy "own runs" on runs for select using (auth.uid() = user_id);
create policy "own coverage" on covered for select using (auth.uid() = user_id);
create policy "areas are public" on areas for select using (true);
create policy "streets are public" on streets for select using (true);

-- The server's secret key runs as service_role, which bypasses RLS but
-- still needs base table privileges (Postgres GRANTs are separate from
-- RLS policies, and aren't inherited automatically on every project).
grant select, insert, update, delete on areas, streets, covered, runs to service_role;

-- Background street-import jobs (added for whole-city tiled imports).
create table if not exists import_jobs (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  query text not null,
  include_paths boolean not null default false,
  status text not null default 'queued'
    check (status in ('queued','running','done','error')),
  phase text not null default 'queued',   -- geocoding | fetching | building | saving | done
  tiles_total int not null default 0,
  tiles_done int not null default 0,
  error text,
  area_id uuid references areas(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One active job per slug: concurrent searches for the same city share a job.
create unique index if not exists import_jobs_active_slug
  on import_jobs(slug) where status in ('queued','running');
-- Lock the table down: no policies needed because only the server's
-- secret key (service_role, which bypasses RLS) ever touches jobs.
alter table import_jobs enable row level security;
grant select, insert, update, delete on import_jobs to service_role;
