# Sub-project 1: Scale the Core — Design Spec

**Date:** 2026-07-15
**Status:** Approved design, awaiting implementation plan
**Owner context:** Public-but-small audience (local running clubs, ~100s of
users). Minimal-ops appetite: keep the public Overpass/Nominatim stack for
now, but preserve a clean seam to swap to self-hosted Geofabrik + PostGIS
later without touching anything outside `server/src/osm.ts`.

---

## 1. Problem

Today an area import is a single synchronous Overpass query capped at
~12 km diagonal (`MAX_DIAGONAL_M` in `server/src/osm.ts`). Whole cities
fail with a 504 or the cap error. The import also blocks the HTTP request
for up to 75 s, and the app only runs on localhost. Goals, in priority
order:

1. Whole-city imports work reliably (raise the cap 12 km → 60 km).
2. Imports run as background jobs with a visible progress bar.
3. The app is deployed and reachable by club members (API + web + DB).
4. Basic hardening so a small public audience can't take it down.

## 2. Non-goals (explicitly out of scope)

- Self-hosted Geofabrik/PostGIS pipeline (future option; this design only
  preserves the seam — `fetchStreets()` keeps its signature).
- Vector tiles / map-side optimization beyond gzip + coordinate rounding.
- Multi-instance API scaling (single instance is a hard requirement of the
  in-memory graph cache and in-process worker; revisit only if usage
  outgrows one box).
- Club/social features (deliberately excluded by owner).
- Full-coverage run planning ("generate all runs to cover the city") —
  that is the core of Sub-project 3. This design's job infrastructure is
  built so Sub-project 3 can reuse it for long-running plan computation.
- Strava/Garmin sync (Sub-project 2), PWA work (Sub-project 4).

## 3. Design

### 3.1 Tiled Overpass imports (`server/src/osm.ts`)

`fetchStreets(bbox, includePaths)` keeps its exact signature and return
shape (array of Overpass `elements`), but internally:

- **Tile grid:** split the area bbox into square tiles of
  `OVERPASS_TILE_KM` (env, default **4 km**) per side. Grid math is a
  pure exported function `tileGrid(bbox, tileKm)` → array of bboxes, so
  it is unit-testable. Tiles are clipped to the area bbox.
- **Size cap:** raise `MAX_DIAGONAL_M` to **60 000**, overridable via env
  `MAX_AREA_DIAGONAL_M`. Areas over the cap still fail fast with the
  existing human-readable error.
- **Fetch loop:** up to **2 tiles in flight** at once. Each tile query is
  the current Overpass QL with the tile's bbox and `[timeout:60]`,
  client-side `AbortSignal.timeout(75_000)`.
- **Retry + mirror rotation:** per tile, up to **3 attempts** with
  exponential backoff (2 s, 8 s, 20 s + jitter). Each retry moves to the
  next mirror in rotation:
  1. `https://overpass-api.de/api/interpreter`
  2. `https://overpass.kumi.systems/api/interpreter`
  3. `https://overpass.private.coffee/api/interpreter`
- **Dedupe:** ways that straddle tile borders are returned by multiple
  tiles; dedupe by OSM way `id` before returning. Pure exported function
  `dedupeElements(elements)` for testability.
- **Progress callback:** `fetchStreets` gains an optional third parameter
  `onProgress?: (tilesDone: number, tilesTotal: number) => void`, used by
  the job worker. Optional, so any existing caller is unaffected.
- **Geocoding:** `geocode()` unchanged (Nominatim, 1 req/s policy) — it
  runs once per new area, so no throttling machinery is needed beyond
  what exists.
- **All-or-nothing:** if any tile exhausts its retries, the whole import
  fails with a human-readable error naming the failed tile count. No
  partial areas are ever saved.

### 3.2 Background import jobs

**New table** (append to `supabase/schema.sql`, with the same
`grant ... to service_role` treatment as the other tables):

```sql
create table if not exists import_jobs (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  query text not null,
  include_paths boolean not null default false,
  status text not null default 'queued'
    check (status in ('queued','running','done','error')),
  phase text not null default 'queued',     -- 'geocoding' | 'fetching' | 'building' | 'saving'
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
```

**API changes** (`server/src/index.ts`):

- `POST /api/area` — if the area is already cached in the DB, respond
  exactly as today (`{ area, streets }`, status 200). Otherwise create a
  job — or reuse the existing active job for that slug — and respond
  **202** `{ jobId }`.
- `GET /api/area/jobs/:id` (new, `requireAuth`) — returns
  `{ status, phase, tilesTotal, tilesDone, error, areaSlug }`. The client
  polls this; when `status === 'done'` it re-POSTs `/api/area`, which now
  hits the cache and returns the full payload.

**Worker** (new `server/src/importWorker.ts`):

- An async loop inside the existing Express process. Concurrency:
  **1 job at a time** (tile-level concurrency of 2 lives inside
  `fetchStreets`).
- Pipeline per job: `geocoding` → `fetching` (updates `tiles_done` after
  each tile via the progress callback) → `building` (graph) → `saving`
  (area + streets rows) → `done` with `area_id` set.
- Any failure → `status = 'error'` with the human-readable message in
  `error`; nothing saved.
- **Startup recovery:** on server boot, any job still marked `running`
  (crashed mid-import) is set to `error` with a "server restarted —
  please retry" message.
- New `server/src/db.ts` functions: `createJob`, `getJob`,
  `getActiveJobBySlug`, `updateJob`, `failStaleRunningJobs`.

**Web UI** (`web/src/App.tsx`, `web/src/api.ts`):

- When area search returns 202, show a progress panel: phase label +
  progress bar (`tiles_done / tiles_total`), polling every **2 s**.
- On `done` → automatically load the area (re-POST). On `error` → show
  the message with a **Retry** button that re-submits the search
  (creating a fresh job).

### 3.3 Deployment

Prerequisite (do first — the repo currently is **not** under git and
`server/.env` holds live secrets):

1. `.gitignore` at repo root: `node_modules/`, `dist/`, `.env`,
   `.env.*.local`.
2. `git init`, initial commit, private GitHub repo.

Then:

- **API → Railway** (~$5/mo Hobby): one service, root `server/`, start
  command `npm run start` (new script: `tsx src/index.ts`). **Exactly one
  instance** — required by the in-memory graph cache and in-process
  worker. Env vars: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `WEB_ORIGIN`
  (the Pages URL), `PORT` provided by Railway.
- **Web → Cloudflare Pages** (free): build `web/` with
  `npm run build`, output `web/dist`. Env vars: `VITE_SUPABASE_URL`,
  `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_API_URL` (the Railway URL).
- **Supabase:** unchanged (existing project).
- **Supabase Auth:** add the Pages URL to Auth → URL Configuration
  (site URL / redirect allow-list) so magic links work in production.
- `SETUP-GUIDE.md` gains a "Deploy it" section covering the above in the
  guide's existing beginner-friendly voice.

### 3.4 Hardening

- **Rate limiting** (`express-rate-limit`): global per-IP limit
  (300 req / 15 min) on `/api/*`; a stricter limit (10 / hour per IP) on
  requests to `POST /api/area` that would trigger a *new import*
  (cache hits don't count against the strict limit).
- **Compression:** `compression` middleware (gzip). City street payloads
  reach tens of MB uncompressed; gzip gets ~80–90% on coordinate JSON.
- **Coordinate rounding:** round street coords to **5 decimals** (~1 m)
  at import time, before saving — shrinks both DB rows and payloads.
  (Run coords already do this in `POST /api/runs`.)
- **Graph cache eviction** (`server/src/index.ts`): replace the "max 20
  areas" cap with a total-edge-count budget (default **500 000 edges**,
  env `GRAPH_CACHE_MAX_EDGES`), evicting least-recently-used areas until
  under budget. A whole city can be 50k+ edges, so a per-area count is
  the right memory proxy.

## 4. Error handling summary

| Failure | Behavior |
|---|---|
| Area over 60 km cap | Immediate 4xx with size + suggestion (no job created) |
| Geocode miss | Job → `error`: "Location not found — try being more specific." |
| Tile fails 3 attempts across mirrors | Job → `error`: human message with tile count; nothing saved; UI Retry button |
| Server restarts mid-job | Job → `error`: "server restarted — please retry" |
| No streets in area | Job → `error`: existing "No streets found" message |
| Same city searched twice concurrently | Second request reuses the first's job (unique active-slug index) |

## 5. Testing

- **Unit (pure functions):** `tileGrid` (tile counts, edge alignment,
  clipping, degenerate tiny bbox → 1 tile) and `dedupeElements`
  (cross-tile duplicate way ids collapse to one). New
  `server/test/tiles.test.mjs`, run by the existing `npm test` pattern.
- **Mocked-fetch:** retry/backoff/mirror rotation — simulate 504 then
  success on mirror 2; simulate 3 hard failures → error surfaces.
- **Existing route-engine test suite:** untouched and must stay green.
- **Manual verification:** import a real whole city (~40–60 km diag),
  watch the progress bar complete, generate a route, mark a run.

## 6. Future seams (why this shape)

- `fetchStreets()` signature unchanged → later PostGIS/Geofabrik swap
  touches only `osm.ts`.
- `import_jobs` + worker + progress polling is generic long-task
  infrastructure → Sub-project 3's coverage-plan computation (adaptive
  plan of looped runs with free start points) reuses it directly.
- Single-instance constraint is documented at the deploy layer, not baked
  into new code paths, so a future move to a shared cache (Redis) isn't
  foreclosed.
