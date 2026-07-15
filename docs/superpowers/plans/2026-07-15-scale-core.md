# Scale the Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Whole-city street imports (60 km cap) running as background jobs with a progress bar, deployed to Railway + Cloudflare Pages, with basic rate-limit/compression hardening.

**Architecture:** `fetchStreets()` in `server/src/osm.ts` keeps its signature but internally splits the bbox into ~4 km tiles fetched with retries across three Overpass mirrors. A new `import_jobs` table + an in-process worker loop make imports asynchronous: `POST /api/area` returns `202 { jobId }` for uncached areas, the web app polls `GET /api/area/jobs/:id` and shows a progress bar, then re-POSTs to load the finished area. The server stays strictly single-instance (in-memory graph cache + in-process worker).

**Tech Stack:** Node 20+/TypeScript/Express 4 (run via `tsx`), Supabase (Postgres + auth), React/Vite, `express-rate-limit`, `compression`. Tests are plain `.mjs` scripts run through `tsx` (see `server/test/engine.test.mjs` for the house pattern — no test framework).

**Spec:** `docs/superpowers/specs/2026-07-15-scale-core-design.md`

## Global Constraints

- Prefix every shell command with `rtk` (user's global tooling rule), e.g. `rtk git status`, `rtk npm test`.
- All server commands run from `D:\atoop\everystreet\server`, web commands from `D:\atoop\everystreet\web`, git commands from repo root — each step says which.
- `server/.env` contains LIVE secrets. It must NEVER be committed. Task 1's `.gitignore` lands before anything else; verify with `git check-ignore` before the first commit.
- Env knobs (exact names + defaults): `OVERPASS_TILE_KM` = 4, `MAX_AREA_DIAGONAL_M` = 60000, `GRAPH_CACHE_MAX_EDGES` = 500000. Read at call time (not module load) so tests can override.
- Overpass mirrors, in rotation order: `https://overpass-api.de/api/interpreter`, `https://overpass.kumi.systems/api/interpreter`, `https://overpass.private.coffee/api/interpreter`. Retry = 3 attempts/tile, backoff 2 s / 8 s (+ up to 1 s jitter) between attempts. Tile fetch concurrency = 2. Job concurrency = 1.
- Imports are all-or-nothing: no partial `areas`/`streets` rows, ever. Fail fast on the first tile that exhausts retries.
- Existing route-engine tests must stay green: `rtk npm test` (server) after every task.
- TypeScript must stay clean: `rtk npx tsc --noEmit` in `server/` (and in `web/` for web tasks) before each commit.
- User-facing error copy is exact — copy strings verbatim from this plan (they match the spec's error table).

---

### Task 1: Git repository + secret protection

The repo is currently NOT under git, and every later task ends in a commit — so this comes first. `.gitignore` must land in the same commit that creates history, because `server/.env` holds live Supabase secrets.

**Files:**
- Create: `.gitignore` (repo root)

**Interfaces:**
- Produces: a git repo at `D:\atoop\everystreet` on branch `main`; all later tasks' `rtk git commit` steps depend on it.

- [ ] **Step 1: Create `.gitignore`**

```gitignore
node_modules/
dist/
.env
.env.*.local
```

- [ ] **Step 2: Initialize the repo**

Run from repo root:
```bash
rtk git init -b main
```
Expected: "Initialized empty Git repository".

- [ ] **Step 3: Verify secrets are ignored (do NOT skip)**

```bash
rtk git check-ignore server/.env web/.env
```
Expected output: both paths printed (meaning both are ignored). If either path is NOT printed, STOP — fix `.gitignore` before committing anything.

- [ ] **Step 4: Stage and inspect**

```bash
rtk git add -A && rtk git status
```
Expected: `SETUP-GUIDE.md`, `README.md`, `docs/`, `server/` sources, `web/` sources, `supabase/schema.sql` staged. `server/.env`, `web/.env`, and `node_modules/` must NOT appear anywhere in the output.

- [ ] **Step 5: Commit**

```bash
rtk git commit -m "chore: initial commit with gitignore protecting env secrets"
```

---

### Task 2: Tile-grid + dedupe pure functions (TDD)

**Files:**
- Create: `server/src/tiles.ts`
- Test: `server/test/tiles.test.mjs`
- Modify: `server/package.json` (test script)

**Interfaces:**
- Consumes: nothing (pure module).
- Produces: `export type BBox = [number, number, number, number]` (south, north, west, east — same order used everywhere in this codebase); `export function tileGrid(bbox: BBox, tileKm: number): BBox[]`; `export function dedupeElements<T extends { id: number }>(elements: T[]): T[]`. Task 3 imports all three.

- [ ] **Step 1: Write the failing test**

Create `server/test/tiles.test.mjs` (follows the house pattern from `engine.test.mjs`: import TS via `tsx`, hand-rolled `assert`, exit code = failure count):

```js
// Tile-grid math + cross-tile dedupe tests.
// Run with: npx tsx test/tiles.test.mjs   (from the server folder)
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { tileGrid, dedupeElements } = await import(
  pathToFileURL(join(here, '../src/tiles.ts')).href
);

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  ✓', msg);
  else { console.error('  ✗ FAIL:', msg); failures++; }
};

// -- tileGrid --
// ~10 km × 10 km bbox at 37°N (0.0904° lat ≈ 10 km; 0.1125° lon ≈ 10 km).
const big = [37.0, 37.0904, -122.0, -121.8875];
const tiles = tileGrid(big, 4);
assert(tiles.length === 9, '10 km × 10 km bbox with 4 km tiles → 3×3 = 9 tiles');
assert(tiles.every(t => t.length === 4), 'every tile is a 4-element bbox');
assert(Math.min(...tiles.map(t => t[0])) === 37.0, 'grid starts at bbox south edge');
assert(Math.min(...tiles.map(t => t[2])) === -122.0, 'grid starts at bbox west edge');
assert(Math.max(...tiles.map(t => t[1])) === 37.0904, 'tiles are clipped to bbox north edge');
assert(Math.max(...tiles.map(t => t[3])) === -121.8875, 'tiles are clipped to bbox east edge');
assert(tiles.every(t => t[0] < t[1] && t[2] < t[3]), 'no degenerate tiles');

// Small bbox (~1 km) → exactly one tile, identical to the bbox.
const small = [37.0, 37.01, -122.0, -121.99];
const one = tileGrid(small, 4);
assert(one.length === 1, 'bbox smaller than one tile → 1 tile');
assert(JSON.stringify(one[0]) === JSON.stringify(small), 'single tile equals the bbox');

// Degenerate zero-area bbox → still returns 1 tile (the bbox itself).
const zero = tileGrid([37.0, 37.0, -122.0, -122.0], 4);
assert(zero.length === 1, 'zero-area bbox → 1 tile fallback');

// -- dedupeElements --
const deduped = dedupeElements([
  { id: 1, tag: 'first' }, { id: 2, tag: 'second' }, { id: 1, tag: 'dupe' }
]);
assert(deduped.length === 2, 'duplicate way ids collapse');
assert(deduped[0].tag === 'first', 'first occurrence wins');
assert(deduped.map(e => e.id).join(',') === '1,2', 'order preserved');

process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run from `server/`: `rtk npx tsx test/tiles.test.mjs`
Expected: FAIL — cannot find module `../src/tiles.ts`.

- [ ] **Step 3: Write the implementation**

Create `server/src/tiles.ts`:

```typescript
// Pure tile-grid math for splitting an area bbox into Overpass-sized
// queries, plus cross-tile dedupe. Kept free of I/O so it's unit-testable.

export type BBox = [number, number, number, number]; // south, north, west, east

const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON_EQUATOR = 111.32;

export function tileGrid(bbox: BBox, tileKm: number): BBox[] {
  const [south, north, west, east] = bbox;
  const latStep = tileKm / KM_PER_DEG_LAT;
  const midLat = (south + north) / 2;
  const kmPerDegLon = KM_PER_DEG_LON_EQUATOR * Math.cos((midLat * Math.PI) / 180);
  const lonStep = tileKm / Math.max(kmPerDegLon, 1e-6);
  const tiles: BBox[] = [];
  for (let s = south; s < north; s += latStep) {
    const n = Math.min(s + latStep, north);
    for (let w = west; w < east; w += lonStep) {
      tiles.push([s, n, w, Math.min(w + lonStep, east)]);
    }
  }
  return tiles.length ? tiles : [bbox];
}

export function dedupeElements<T extends { id: number }>(elements: T[]): T[] {
  const seen = new Set<number>();
  const out: T[] = [];
  for (const el of elements) {
    if (!seen.has(el.id)) { seen.add(el.id); out.push(el); }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run from `server/`: `rtk npx tsx test/tiles.test.mjs`
Expected: all ✓, exit code 0.

- [ ] **Step 5: Wire into `npm test`**

In `server/package.json`, change the test script line:

```json
    "test": "tsx test/engine.test.mjs && tsx test/tiles.test.mjs",
```

Run from `server/`: `rtk npm test` — expected: engine tests then tile tests, all pass.

- [ ] **Step 6: Typecheck and commit**

From `server/`: `rtk npx tsc --noEmit` — expected: no output.
From repo root:
```bash
rtk git add server/src/tiles.ts server/test/tiles.test.mjs server/package.json
rtk git commit -m "feat: tile-grid math and cross-tile dedupe for tiled Overpass imports"
```

---

### Task 3: Tiled `fetchStreets` with retry + mirror rotation (TDD)

**Files:**
- Modify: `server/src/osm.ts` (full rewrite of the file below `geocode` — `geocode` itself is untouched)
- Test: `server/test/osm.test.mjs`
- Modify: `server/package.json` (test script)

**Interfaces:**
- Consumes: `tileGrid`, `dedupeElements`, `BBox` from `./tiles.js` (Task 2); `haversine(lat1, lon1, lat2, lon2): number` from `./engine.js` (exists).
- Produces: `export async function fetchStreets(bbox: BBox, includePaths: boolean, onProgress?: (tilesDone: number, tilesTotal: number) => void, opts?: FetchOpts): Promise<any[]>` — same first two params and return shape as today, so `index.ts`/the worker keep working. Also `export async function fetchTile(bbox: BBox, types: string, opts?: FetchOpts)` and `export type FetchOpts = { fetchImpl?: typeof fetch; backoffMs?: number[] }` (test seams). Task 5 calls `fetchStreets(geo.bbox, job.include_paths, onProgress)`.

- [ ] **Step 1: Write the failing test**

Create `server/test/osm.test.mjs`:

```js
// fetchTile retry/mirror-rotation + fetchStreets tiling tests (mocked fetch,
// zero backoff — no network). Run with: npx tsx test/osm.test.mjs
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { fetchTile, fetchStreets } = await import(
  pathToFileURL(join(here, '../src/osm.ts')).href
);

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  ✓', msg);
  else { console.error('  ✗ FAIL:', msg); failures++; }
};
const NO_BACKOFF = { backoffMs: [0, 0] };
const ok = (ids) => ({ ok: true, json: async () => ({ elements: ids.map(id => ({ type: 'way', id })) }) });
const busy = { ok: false, status: 504 };
const tinyBbox = [37.0, 37.01, -122.0, -121.99]; // fits in one 4 km tile

// -- retry moves to the next mirror --
{
  const calls = [];
  const mock = async (url) => { calls.push(String(url)); return calls.length === 1 ? busy : ok([42]); };
  const els = await fetchTile(tinyBbox, 'residential', { fetchImpl: mock, ...NO_BACKOFF });
  assert(els.length === 1 && els[0].id === 42, 'returns elements after one retry');
  assert(calls.length === 2, 'exactly two attempts made');
  assert(calls[0].includes('overpass-api.de'), 'first attempt uses primary mirror');
  assert(calls[1].includes('kumi.systems'), 'second attempt rotates to second mirror');
}

// -- three hard failures exhaust all mirrors and throw --
{
  const calls = [];
  const mock = async (url) => { calls.push(String(url)); return busy; };
  let threw = null;
  try { await fetchTile(tinyBbox, 'residential', { fetchImpl: mock, ...NO_BACKOFF }); }
  catch (e) { threw = e; }
  assert(threw !== null, 'throws after 3 failed attempts');
  assert(calls.length === 3, 'exactly three attempts made');
  assert(calls[2].includes('private.coffee'), 'third attempt uses third mirror');
}

// -- fetchStreets: tiles a larger bbox, dedupes across tiles, reports progress --
{
  // ~8 km tall × 4 km wide at 37°N → 2 tiles with 4 km tiles.
  const twoTileBbox = [37.0, 37.0724, -122.0, -121.955];
  const progress = [];
  const mock = async () => ok([7, 8]); // both tiles return the same way ids
  const els = await fetchStreets(twoTileBbox, false,
    (done, total) => progress.push([done, total]), { fetchImpl: mock, ...NO_BACKOFF });
  assert(els.length === 2, 'duplicate ways across tiles are deduped');
  assert(progress.length === 2, 'progress reported once per tile');
  assert(JSON.stringify(progress[progress.length - 1]) === '[2,2]', 'final progress is [tiles, tiles]');
}

// -- oversized area rejected before any network call --
{
  let called = false;
  const mock = async () => { called = true; return ok([1]); };
  let threw = null;
  try { await fetchStreets([37.0, 38.0, -122.0, -120.5], false, undefined, { fetchImpl: mock }); }
  catch (e) { threw = e; }
  assert(threw && /too large/.test(threw.message), 'oversized area throws the size-cap error');
  assert(!called, 'no fetch attempted for oversized area');
}

process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

From `server/`: `rtk npx tsx test/osm.test.mjs`
Expected: FAIL — `fetchTile` is not exported (and `fetchStreets` has no opts param).

- [ ] **Step 3: Rewrite `server/src/osm.ts`**

Replace everything below the `geocode` function (keep the file header comment, `UA`, `GeoResult`, and `geocode` exactly as they are) with:

```typescript
// The public Overpass instances can't finish a whole city in one query, so
// large areas are split into ~4 km tiles fetched with retries across
// mirrors. Signature of fetchStreets is stable: a future self-hosted
// PostGIS/Geofabrik swap replaces only this file.

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];
const DEFAULT_BACKOFF_MS = [2000, 8000];
const TILE_CONCURRENCY = 2;
const ATTEMPTS = 3;

const maxDiagonalM = () => Number(process.env.MAX_AREA_DIAGONAL_M || 60_000);
const tileKm = () => Number(process.env.OVERPASS_TILE_KM || 4);

export type FetchOpts = { fetchImpl?: typeof fetch; backoffMs?: number[] };

export async function fetchTile(bbox: BBox, types: string, opts: FetchOpts = {}): Promise<any[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const [south, north, west, east] = bbox;
  const q = `[out:json][timeout:60];way["highway"~"^(${types})$"]["area"!~"yes"](${south},${west},${north},${east});out geom;`;
  let lastErr = new Error('Street data fetch failed.');
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const wait = backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? 0;
      await new Promise(r => setTimeout(r, wait + Math.random() * (wait ? 1000 : 0)));
    }
    try {
      const res = await fetchImpl(MIRRORS[attempt % MIRRORS.length], {
        method: 'POST', body: q, headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(75_000)
      });
      if (res.ok) return ((await res.json()) as { elements?: any[] }).elements || [];
      lastErr = new Error(`Street data fetch failed (${res.status}).`);
    } catch (err: any) {
      lastErr = err?.name === 'TimeoutError' || err?.name === 'AbortError'
        ? new Error('Street data request timed out.')
        : err;
    }
  }
  throw lastErr;
}

export async function fetchStreets(
  bbox: BBox,
  includePaths: boolean,
  onProgress?: (tilesDone: number, tilesTotal: number) => void,
  opts: FetchOpts = {}
): Promise<any[]> {
  const [south, north, west, east] = bbox;
  const diag = haversine(south, west, north, east);
  const maxDiag = maxDiagonalM();
  if (diag > maxDiag) {
    throw new Error(`That area is ${(diag / 1000).toFixed(0)} km across — too large for one import (limit ~${Math.round(maxDiag / 1000)} km). Try a smaller search.`);
  }
  const types = includePaths
    ? 'primary|secondary|tertiary|unclassified|residential|living_street|pedestrian|footway|path|cycleway'
    : 'primary|secondary|tertiary|unclassified|residential|living_street|pedestrian';
  const tiles = tileGrid(bbox, tileKm());
  const all: any[] = [];
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < tiles.length) {
      const i = next++;
      try {
        all.push(...await fetchTile(tiles[i], types, opts));
      } catch (err: any) {
        // All-or-nothing: first tile to exhaust retries fails the import.
        throw new Error(`Street data fetch failed on map tile ${i + 1} of ${tiles.length} after ${ATTEMPTS} attempts — Overpass may be overloaded. Please retry in a few minutes. (${err?.message || err})`);
      }
      done++;
      onProgress?.(done, tiles.length);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(TILE_CONCURRENCY, tiles.length) }, worker)
  );
  const elements = dedupeElements(all as { id: number }[]);
  if (!elements.length) throw new Error('No streets found in that area.');
  return elements;
}
```

Also update the imports at the top of the file to:

```typescript
import { haversine } from './engine.js';
import { tileGrid, dedupeElements, type BBox } from './tiles.js';
```

Delete the old `MAX_DIAGONAL_M` constant and the old `fetchStreets` body entirely (they are replaced by the above).

- [ ] **Step 4: Run tests to verify they pass**

From `server/`:
```bash
rtk npx tsx test/osm.test.mjs
```
Expected: all ✓, exit 0. Then add it to the suite — in `server/package.json`:

```json
    "test": "tsx test/engine.test.mjs && tsx test/tiles.test.mjs && tsx test/osm.test.mjs",
```

Run `rtk npm test` — expected: all three files pass.

- [ ] **Step 5: Typecheck and commit**

From `server/`: `rtk npx tsc --noEmit` — expected: clean. (`index.ts` still calls `fetchStreets(geo.bbox, !!includePaths)` — the two new params are optional, so it compiles and still works.)
From repo root:
```bash
rtk git add server/src/osm.ts server/test/osm.test.mjs server/package.json
rtk git commit -m "feat: tiled Overpass fetch with retries and mirror rotation, 60 km cap"
```

---

### Task 4: `import_jobs` schema + job DB functions

**Files:**
- Modify: `supabase/schema.sql` (append)
- Modify: `server/src/db.ts` (append)

**Interfaces:**
- Consumes: `db()` Supabase client helper (exists in `db.ts`).
- Produces (all in `server/src/db.ts`, used by Tasks 5–6):
  - `export interface JobRow { id: string; slug: string; query: string; include_paths: boolean; status: 'queued'|'running'|'done'|'error'; phase: string; tiles_total: number; tiles_done: number; error: string | null; area_id: string | null; created_at: string }`
  - `createJob(slug: string, query: string, includePaths: boolean): Promise<JobRow>` (unique-violation-safe: returns the existing active job on a race)
  - `getJob(id: string): Promise<JobRow | null>`
  - `getActiveJobBySlug(slug: string): Promise<JobRow | null>`
  - `claimNextJob(): Promise<JobRow | null>` (oldest queued → marked running)
  - `updateJob(id: string, patch: Partial<Pick<JobRow, 'status'|'phase'|'tiles_total'|'tiles_done'|'error'|'area_id'>>): Promise<void>`
  - `failStaleRunningJobs(): Promise<void>`

- [ ] **Step 1: Append to `supabase/schema.sql`**

```sql
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
grant select, insert, update, delete on import_jobs to service_role;
```

- [ ] **Step 2: Run the new SQL in Supabase (manual, user or executor with dashboard access)**

In the Supabase dashboard → SQL Editor → New query → paste ONLY the block from Step 1 → Run. Expected: "Success".
⚠️ Do NOT re-run the whole `schema.sql` file — its `create policy` statements are not idempotent and will error.

- [ ] **Step 3: Append job functions to `server/src/db.ts`**

```typescript
export interface JobRow {
  id: string; slug: string; query: string; include_paths: boolean;
  status: 'queued' | 'running' | 'done' | 'error';
  phase: string; tiles_total: number; tiles_done: number;
  error: string | null; area_id: string | null; created_at: string;
}

export async function createJob(slug: string, query: string, includePaths: boolean): Promise<JobRow> {
  const { data, error } = await db().from('import_jobs')
    .insert({ slug, query, include_paths: includePaths }).select().single();
  if (error) {
    // 23505 = unique violation: a concurrent request created the active
    // job for this slug first — share it instead of failing.
    if ((error as { code?: string }).code === '23505') {
      const existing = await getActiveJobBySlug(slug);
      if (existing) return existing;
    }
    throw error;
  }
  return data as JobRow;
}

export async function getJob(id: string): Promise<JobRow | null> {
  const { data, error } = await db().from('import_jobs').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data as JobRow | null;
}

export async function getActiveJobBySlug(slug: string): Promise<JobRow | null> {
  const { data, error } = await db().from('import_jobs').select('*')
    .eq('slug', slug).in('status', ['queued', 'running'])
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data as JobRow | null;
}

export async function claimNextJob(): Promise<JobRow | null> {
  // Single-worker process, so select-then-update has no real race.
  const { data, error } = await db().from('import_jobs').select('*')
    .eq('status', 'queued').order('created_at', { ascending: true })
    .limit(1).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  await updateJob(data.id, { status: 'running', phase: 'geocoding' });
  return { ...(data as JobRow), status: 'running', phase: 'geocoding' };
}

export async function updateJob(
  id: string,
  patch: Partial<Pick<JobRow, 'status' | 'phase' | 'tiles_total' | 'tiles_done' | 'error' | 'area_id'>>
): Promise<void> {
  const { error } = await db().from('import_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

export async function failStaleRunningJobs(): Promise<void> {
  // Queued jobs survive a restart (the worker will pick them up); only
  // jobs caught mid-flight are unrecoverable.
  const { error } = await db().from('import_jobs')
    .update({
      status: 'error',
      error: 'The server restarted mid-import — please retry.',
      updated_at: new Date().toISOString()
    })
    .eq('status', 'running');
  if (error) throw error;
}
```

- [ ] **Step 4: Typecheck**

From `server/`: `rtk npx tsc --noEmit` — expected: clean. (These are thin DB wrappers against a live database — no unit tests; they're exercised end-to-end in Task 6 Step 6 and the final verification.)

- [ ] **Step 5: Commit**

From repo root:
```bash
rtk git add supabase/schema.sql server/src/db.ts
rtk git commit -m "feat: import_jobs table and job store functions"
```

---

### Task 5: Import worker + shared graph cache

**Files:**
- Create: `server/src/importWorker.ts`
- Create: `server/src/graphCache.ts`

**Interfaces:**
- Consumes: `claimNextJob`, `updateJob`, `failStaleRunningJobs`, `saveArea`, `getStreets`, `JobRow`, `AreaRow` from `./db.js` (Task 4); `geocode`, `fetchStreets` from `./osm.js` (Task 3); `buildGraph`, `graphFromRows`, `Graph` from `./engine.js` (exists).
- Produces: `export function startImportWorker(): void` (idempotent; call once at boot — Task 6). From `graphCache.ts`: `export async function loadGraph(area: AreaRow): Promise<Graph>` and `export function putGraph(slug: string, g: Graph): void` — Task 6 replaces `index.ts`'s inline cache with these.

- [ ] **Step 1: Create `server/src/graphCache.ts`**

This ports the in-memory cache out of `index.ts` (so the worker can prime it) and replaces the old "max 20 areas" cap with the spec's edge-count budget:

```typescript
// In-memory route-graph cache, shared by the API and the import worker.
// Eviction is by total edge count, not area count: a whole city is 50k+
// edges while a neighborhood is a few hundred, so edges are the honest
// memory proxy. Requires a single server instance (see deploy notes).
import { graphFromRows, type Graph } from './engine.js';
import * as store from './db.js';
import type { AreaRow } from './db.js';

const maxEdges = () => Number(process.env.GRAPH_CACHE_MAX_EDGES || 500_000);
const cache = new Map<string, Graph>(); // Map iteration order ≈ LRU (oldest first)

export function putGraph(slug: string, g: Graph): void {
  cache.delete(slug);
  cache.set(slug, g);
  let total = 0;
  for (const cached of cache.values()) total += cached.edges.size;
  for (const [key, cached] of cache) {
    if (total <= maxEdges() || cache.size === 1) break;
    cache.delete(key);
    total -= cached.edges.size;
  }
}

export async function loadGraph(area: AreaRow): Promise<Graph> {
  const hit = cache.get(area.slug);
  if (hit) {
    cache.delete(area.slug); // refresh recency
    cache.set(area.slug, hit);
    return hit;
  }
  const rows = await store.getStreets(area.id);
  const g = graphFromRows(rows);
  putGraph(area.slug, g);
  return g;
}
```

- [ ] **Step 2: Create `server/src/importWorker.ts`**

```typescript
// Background street-import worker: an async loop inside the single server
// process. Polls import_jobs for queued work (so queued jobs survive a
// restart), processes ONE job at a time, and records progress per tile.
// Imports are all-or-nothing: any failure marks the job error and saves
// nothing. Sub-project 3's coverage-plan computation will reuse this shape.
import * as store from './db.js';
import { geocode, fetchStreets } from './osm.js';
import { buildGraph } from './engine.js';
import { putGraph } from './graphCache.js';

const POLL_MS = 2000;
let started = false;

export function startImportWorker(): void {
  if (started) return;
  started = true;
  void loop();
}

async function loop(): Promise<void> {
  try {
    await store.failStaleRunningJobs();
  } catch (err) {
    console.error('Import worker: stale-job cleanup failed:', err);
  }
  for (;;) {
    try {
      const job = await store.claimNextJob();
      if (job) await runJob(job);
      else await new Promise(r => setTimeout(r, POLL_MS));
    } catch (err) {
      console.error('Import worker loop error:', err);
      await new Promise(r => setTimeout(r, POLL_MS));
    }
  }
}

async function runJob(job: store.JobRow): Promise<void> {
  try {
    const geo = await geocode(job.query);
    await store.updateJob(job.id, { phase: 'fetching' });
    let lastWrite = 0;
    const elements = await fetchStreets(geo.bbox, job.include_paths, (done, total) => {
      // Throttle progress writes to ~1/s (plus always the final tile).
      const now = Date.now();
      if (now - lastWrite > 1000 || done === total) {
        lastWrite = now;
        store.updateJob(job.id, { tiles_done: done, tiles_total: total })
          .catch(e => console.error('Progress write failed:', e));
      }
    });
    await store.updateJob(job.id, { phase: 'building' });
    const graph = buildGraph(elements);
    if (!graph.edges.size) throw new Error('No usable streets found there.');
    let total = 0;
    const streets = [...graph.edges.values()].map(e => {
      total += e.length;
      return {
        edge_id: e.id, name: e.name, length_m: e.length,
        from_node: e.from, to_node: e.to,
        // Round to 5 decimals (~1 m) — shrinks rows and payloads.
        coords: e.coords.map(c =>
          [Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5] as [number, number])
      };
    });
    await store.updateJob(job.id, { phase: 'saving' });
    const area = await store.saveArea({
      slug: job.slug, label: geo.displayName,
      bbox: geo.bbox, center: [geo.lat, geo.lon],
      street_count: graph.edges.size, total_length_m: total
    }, streets);
    putGraph(job.slug, graph);
    await store.updateJob(job.id, { status: 'done', phase: 'done', area_id: area.id });
  } catch (err: any) {
    await store.updateJob(job.id, {
      status: 'error',
      error: err?.message || 'Import failed.'
    }).catch(e => console.error('Could not record job failure:', e));
  }
}
```

- [ ] **Step 3: Typecheck**

From `server/`: `rtk npx tsc --noEmit` — expected: clean. (The worker's logic is thin orchestration over already-tested pieces — `fetchStreets` retry/tiling is covered by Task 3's tests; the worker is exercised end-to-end in Task 6 Step 6.)

- [ ] **Step 4: Commit**

From repo root:
```bash
rtk git add server/src/importWorker.ts server/src/graphCache.ts
rtk git commit -m "feat: background import worker and shared edge-budget graph cache"
```

---

### Task 6: API — 202 job responses + job polling endpoint

**Files:**
- Modify: `server/src/index.ts`

**Interfaces:**
- Consumes: `startImportWorker` (Task 5), `loadGraph` from `./graphCache.js` (Task 5), `getActiveJobBySlug`/`createJob`/`getJob` from `./db.js` (Task 4), `geocode` + `fetchStreets` size-cap error (Task 3).
- Produces the HTTP contract Task 7's web client relies on:
  - `POST /api/area` → `200 { area, streets }` (cached) | `202 { jobId: string }` (import started/reused) | `4xx { error }` (bad query, geocode miss, oversized area — checked BEFORE any job is created)
  - `GET /api/area/jobs/:id` → `200 { status, phase, tilesTotal, tilesDone, error, areaSlug }` | `404 { error }`

- [ ] **Step 1: Update imports and remove the inline cache**

In `server/src/index.ts`:

1. Replace the two import lines for engine/osm (graph-building and street fetching now live in the worker; `haversine` is newly needed for the size cap):
```typescript
import { generateRoute, pickStart, haversine } from './engine.js';
import { geocode } from './osm.js';
```
2. Add:
```typescript
import { loadGraph } from './graphCache.js';
import { startImportWorker } from './importWorker.js';
```
3. Delete the whole inline cache block (the `graphCache` Map and the local `async function loadGraph(...)`, currently `index.ts:17-27`). Every existing `loadGraph(area)` call site keeps working via the new import.

- [ ] **Step 2: Replace the `POST /api/area` handler**

Replace the existing handler body with:

```typescript
/** Search an area. Cached → full payload. Uncached → 202 + background job. */
app.post('/api/area', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const { query, includePaths } = req.body as { query: string; includePaths?: boolean };
    if (!query?.trim()) return res.status(400).json({ error: 'Enter a city or neighborhood.' });
    const slug = slugify(query) + (includePaths ? '-paths' : '');
    const area = await store.getArea(slug);
    if (area) {
      const graph = await loadGraph(area);
      const covered = await store.getCovered(req.userId!, area.slug);
      const streets = [...graph.edges.values()].map(e => ({
        id: e.id, name: e.name, length: e.length, coords: e.coords,
        times: covered.get(e.id) || 0
      }));
      return res.json({ area, streets });
    }
    // Someone already importing this area? Share their job.
    const active = await store.getActiveJobBySlug(slug);
    if (active) return res.status(202).json({ jobId: active.id });
    // Fail fast BEFORE creating a job: bad locations and oversized areas
    // get an immediate 4xx. (The worker geocodes again — one extra
    // Nominatim call per brand-new area, well within its 1 req/s policy.)
    const geo = await geocode(query);
    const [s, n, w, e] = geo.bbox;
    const maxDiag = Number(process.env.MAX_AREA_DIAGONAL_M || 60_000);
    const diag = haversine(s, w, n, e);
    if (diag > maxDiag) {
      return res.status(400).json({ error: `That area is ${(diag / 1000).toFixed(0)} km across — too large for one import (limit ~${Math.round(maxDiag / 1000)} km). Try a smaller search.` });
    }
    const job = await store.createJob(slug, query, !!includePaths);
    return res.status(202).json({ jobId: job.id });
  } catch (err: any) {
    res.status(err?.message?.includes('not found') ? 404 : 500)
      .json({ error: err.message || 'Area import failed.' });
  }
});
```

- [ ] **Step 3: Add the job-polling endpoint** (directly below the `/api/area` handler)

```typescript
/** Poll a background import job. */
app.get('/api/area/jobs/:id', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const job = await store.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Import job not found.' });
    res.json({
      status: job.status, phase: job.phase,
      tilesTotal: job.tiles_total, tilesDone: job.tiles_done,
      error: job.error, areaSlug: job.slug
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Start the worker at boot**

Just above the final `app.listen(...)` line:

```typescript
startImportWorker();
```

- [ ] **Step 5: Typecheck + tests**

From `server/`: `rtk npx tsc --noEmit` then `rtk npm test` — expected: clean, all pass.

- [ ] **Step 6: End-to-end smoke test against the real server**

From `server/`: start `rtk npm run dev`. Then (needs a valid session token — sign into the web app locally and copy `access_token` from DevTools → Application → Local Storage → the `sb-...-auth-token` entry, or run the web app for Task 7 and test there):

1. `POST http://localhost:3001/api/area` with `{"query":"<a small town NOT yet in your areas table>"}` → expect `202 {"jobId":"..."}`.
2. `GET http://localhost:3001/api/area/jobs/<jobId>` repeatedly → expect `status` to move `queued → running` with `phase` advancing and `tilesDone` climbing, ending at `status: "done"`.
3. Re-`POST /api/area` with the same query → expect `200` with `area` + `streets`.
4. Server console shows no unhandled errors.

If manual curl is awkward on Windows, defer this smoke test to Task 7 Step 5, where the web UI drives the same flow — but do not skip both.

- [ ] **Step 7: Commit**

```bash
rtk git add server/src/index.ts
rtk git commit -m "feat: async area imports — 202 job responses and polling endpoint"
```

---

### Task 7: Web UI — progress bar + polling

**Files:**
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: the Task 6 HTTP contract; existing `api<T>()` helper in `web/src/api.ts` (unchanged — a 202 is `res.ok`, so `api()` returns the `{ jobId }` body as-is; the client branches on the response shape).
- Produces: user-visible import progress. No exports.

- [ ] **Step 1: Add the job type and state**

In `web/src/App.tsx`, below the existing `type Run = ...` line add:

```typescript
type ImportJob = { status: string; phase: string; tilesTotal: number; tilesDone: number; error: string | null; areaSlug: string };
```

Inside `Mapper`, next to the other `useState` calls add:

```typescript
const [job, setJob] = useState<ImportJob | null>(null);
```

- [ ] **Step 2: Replace `findArea` with the branching version + poller**

Replace the existing `findArea` function with:

```typescript
const showArea = async (res: { area: Area; streets: Street[] }) => {
  setArea(res.area); setStreets(res.streets); setRoute(null);
  const map = mapRef.current!;
  const [s, n, w, e] = res.area.bbox;
  map.fitBounds([[w, s], [e, n]], { padding: 40 });
  const runsRes = await api<{ runs: Run[] }>(`/api/runs?areaSlug=${encodeURIComponent(res.area.slug)}`);
  setRuns(runsRes.runs);
  say(`Loaded ${res.streets.length} street segments.`);
};

const pollJob = (jobId: string) => {
  const tick = async () => {
    try {
      const j = await api<ImportJob>(`/api/area/jobs/${jobId}`);
      setJob(j);
      if (j.status === 'done') {
        setJob(null);
        const res = await api<{ area: Area; streets: Street[] } | { jobId: string }>('/api/area', { query, includePaths });
        if ('jobId' in res) say('Import finished but the area could not be loaded — try searching again.', true);
        else await showArea(res);
        setBusy(false);
        return;
      }
      if (j.status === 'error') {
        say((j.error || 'Import failed.') + ' Click "Find streets" to retry.', true);
        setJob(null); setBusy(false);
        return;
      }
      setTimeout(tick, 2000);
    } catch (err: any) {
      say(err.message, true); setJob(null); setBusy(false);
    }
  };
  tick();
};

const findArea = async () => {
  if (!query.trim()) return say('Enter a city or neighborhood first.', true);
  setBusy(true); setJob(null); say('Searching…');
  try {
    const res = await api<{ area: Area; streets: Street[] } | { jobId: string }>('/api/area', { query, includePaths });
    if ('jobId' in res) {
      say('Importing streets — this can take a few minutes for a whole city.');
      pollJob(res.jobId);
      return; // stays busy until the poller resolves
    }
    await showArea(res);
    setBusy(false);
  } catch (err: any) {
    say(err.message, true);
    setBusy(false);
  }
};
```

Note the `finally { setBusy(false) }` from the old version is intentionally gone — the poller owns `setBusy(false)` on the async path. (The old `complete()` function still calls `/api/area` for a cached area, which returns 200 — but its response is typed `{ area, streets }`; it keeps working unchanged.)

- [ ] **Step 3: Render the progress panel**

In the `01 · Area` section of the JSX, directly after the `<button className="primary" onClick={findArea} ...>Find streets</button>` line, add:

```tsx
{job && <div className="importjob">
  <p className="hint">{job.phase === 'fetching' && job.tilesTotal > 0
    ? `Importing streets — tile ${job.tilesDone} of ${job.tilesTotal}`
    : `Importing streets — ${job.phase}…`}</p>
  <div className="coverbar"><div className="fill" style={{
    width: (job.tilesTotal > 0 ? Math.max(5, (job.tilesDone / job.tilesTotal) * 100) : 5) + '%'
  }} /></div>
</div>}
```

(`coverbar`/`fill` classes already exist in `styles.css` — reused from the coverage section. `importjob` needs no own styling; if spacing looks cramped, add `.importjob { margin-top: 10px; }` to `web/src/styles.css`.)

- [ ] **Step 4: Typecheck**

From `web/`: `rtk npx tsc --noEmit` — expected: clean.

- [ ] **Step 5: Manual verification (required — this is the task's test)**

Run both dev servers (`rtk npm run dev` in `server/` and in `web/`), sign in, and:

1. Search an area already in the DB → loads instantly, no progress bar (200 path).
2. Search a NEW small town → progress bar appears, phase text advances (`geocoding` → tile counts → `building` → `saving`), then streets render on the map.
3. While an import runs, search the same town from a second browser tab → both tabs track the same job (same tile counts).
4. Search something gibberish ("zzzzqqq") → immediate "Location not found" error, no job/progress bar.
5. Search a huge area ("California") → immediate "too large" error, no job.

- [ ] **Step 6: Commit**

```bash
rtk git add web/src/App.tsx web/src/styles.css
rtk git commit -m "feat: import progress bar with job polling in web app"
```

---

### Task 8: Hardening — rate limits, compression, proxy trust

**Files:**
- Modify: `server/src/index.ts`
- Modify: `server/package.json` (+ lockfile, via npm install)

**Interfaces:**
- Consumes: Task 6's `/api/area` handler shape.
- Produces: global per-IP limit 300 req/15 min on `/api/*`; strict limit 10/hour per IP on *new-import* attempts only (cache hits and shared active jobs don't count); gzip on all responses.

- [ ] **Step 1: Install dependencies**

From `server/`:
```bash
rtk npm install express-rate-limit compression
rtk npm install -D @types/compression
```

- [ ] **Step 2: Add middleware**

In `server/src/index.ts` add imports:

```typescript
import rateLimit from 'express-rate-limit';
import compression from 'compression';
```

Directly after `const app = express();` add:

```typescript
// Behind Railway's proxy in production; needed for real client IPs.
app.set('trust proxy', 1);
app.use(compression());
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000, limit: 300,
  standardHeaders: true, legacyHeaders: false,
  // Job polling fires every 2 s for many minutes during a city import —
  // it must not eat the budget (450+ polls per 15 min is normal).
  skip: req => req.path.startsWith('/area/jobs/'),
  message: { error: 'Too many requests — slow down and try again shortly.' }
}));

// Stricter budget for expensive new-area imports (applied manually inside
// the /api/area handler so cached areas and shared jobs don't consume it).
const importLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many new area imports from this connection — try again in an hour.' }
});
```

- [ ] **Step 3: Gate new imports with the strict limiter**

In the `POST /api/area` handler from Task 6, wrap everything AFTER the active-job check in the limiter. The section that currently reads:

```typescript
    const active = await store.getActiveJobBySlug(slug);
    if (active) return res.status(202).json({ jobId: active.id });
    const geo = await geocode(query);
    ...
    return res.status(202).json({ jobId: job.id });
```

becomes:

```typescript
    const active = await store.getActiveJobBySlug(slug);
    if (active) return res.status(202).json({ jobId: active.id });
    // Only genuinely-new imports consume the strict budget.
    importLimiter(req, res, () => {
      void (async () => {
        try {
          const geo = await geocode(query);
          const [s, n, w, e] = geo.bbox;
          const maxDiag = Number(process.env.MAX_AREA_DIAGONAL_M || 60_000);
          const diag = haversine(s, w, n, e);
          if (diag > maxDiag) {
            return res.status(400).json({ error: `That area is ${(diag / 1000).toFixed(0)} km across — too large for one import (limit ~${Math.round(maxDiag / 1000)} km). Try a smaller search.` });
          }
          const job = await store.createJob(slug, query, !!includePaths);
          res.status(202).json({ jobId: job.id });
        } catch (err: any) {
          res.status(err?.message?.includes('not found') ? 404 : 500)
            .json({ error: err.message || 'Area import failed.' });
        }
      })();
    });
    return;
```

(`importLimiter` sends its own 429 JSON when the budget is exhausted and never calls the callback, so the handler needs no extra branch.)

- [ ] **Step 4: Typecheck + tests + smoke**

From `server/`: `rtk npx tsc --noEmit && rtk npm test` — expected: clean/pass.
Start `rtk npm run dev` and load the web app: searching a cached area must still work (verifies compression + global limiter didn't break responses; check DevTools → Network → the `/api/area` response has `Content-Encoding: gzip`).

- [ ] **Step 5: Commit**

```bash
rtk git add server/src/index.ts server/package.json server/package-lock.json
rtk git commit -m "feat: per-IP rate limits, import budget, and gzip compression"
```

---

### Task 9: Deployment — GitHub, Railway, Cloudflare Pages + guide

Mostly dashboard work the user performs; the code/docs parts are exact below. Do the docs first so the user can follow them.

**Files:**
- Modify: `SETUP-GUIDE.md` (append new section before "Working on this with Claude Code")
- Modify: `server/.env.example` (document new optional knobs)

**Interfaces:**
- Consumes: everything prior; `server/package.json` already has `"start": "tsx src/index.ts"` (verified — no change needed).
- Produces: live URLs (Railway API + Pages site) and a guide section the user can re-follow.

- [ ] **Step 1: Document the new env knobs in `server/.env.example`**

Append:

```bash
# Optional tuning (defaults shown; leave unset unless needed)
# OVERPASS_TILE_KM=4            # import tile size in km
# MAX_AREA_DIAGONAL_M=60000     # max area size (m across)
# GRAPH_CACHE_MAX_EDGES=500000  # in-memory graph cache budget
```

- [ ] **Step 2: Add the deploy section to `SETUP-GUIDE.md`**

Insert before the "## Working on this with Claude Code" heading:

```markdown
## Deploying for your club (optional)

Everything above runs on your own computer. To give your running club a
real web address, you'll put the three pieces online. Supabase is already
online — that part's done. The other two:

**The API server → Railway** (about $5/month)

1. First, the code needs to be on GitHub. In the VS Code terminal, from
   the project folder: create a GitHub account if needed, install the
   GitHub CLI (https://cli.github.com), then run `gh auth login` followed
   by `gh repo create everystreet --private --source . --push`.
2. Go to https://railway.app → sign in with GitHub → **New Project →
   Deploy from GitHub repo** → pick `everystreet`.
3. In the service settings: set **Root Directory** to `server`, and the
   **Start Command** to `npm start`.
4. Under **Variables**, add: `SUPABASE_URL` and `SUPABASE_SECRET_KEY`
   (same values as your `server/.env`), and `WEB_ORIGIN` (your Pages URL
   from the next part — come back and set it after step "The web app").
5. Under **Settings → Networking**, generate a public domain. That's
   your API URL (like `https://everystreet-production.up.railway.app`).
6. ⚠️ Keep it to **exactly one instance** (Railway's default). The app
   keeps street graphs and the import worker in memory, so two copies
   would fight each other.

**The web app → Cloudflare Pages** (free)

1. Go to https://pages.cloudflare.com → sign in → **Create a project →
   Connect to Git** → pick the `everystreet` repo.
2. Build settings: **Root directory** `web`, **Build command**
   `npm run build`, **Build output directory** `dist`.
3. Environment variables (Production): `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_PUBLISHABLE_KEY` (same as your `web/.env`), and
   `VITE_API_URL` = your Railway URL from above.
4. Deploy. Your site gets an address like `https://everystreet.pages.dev`
   — now go back to Railway and set `WEB_ORIGIN` to exactly that address.

**Tell Supabase about the new address**

In the Supabase dashboard → **Authentication → URL Configuration**: set
**Site URL** to your Pages address and add it to **Redirect URLs**.
Otherwise sign-in links will bounce people back to localhost.

**Updating later:** push to GitHub (`git push`) — Railway and Pages both
redeploy automatically.
```

- [ ] **Step 3: Commit the docs**

```bash
rtk git add SETUP-GUIDE.md server/.env.example
rtk git commit -m "docs: deployment guide (Railway + Cloudflare Pages) and env knobs"
```

- [ ] **Step 4: Execute the deployment (user-driven, follow the new guide section)**

Walk through the guide section just written, in order: GitHub push → Railway → Pages → `WEB_ORIGIN` back-fill → Supabase URL configuration. Expected end state: visiting the Pages URL shows the sign-in screen; magic-link sign-in works; searching a cached area loads streets.

- [ ] **Step 5: Production smoke test**

On the live Pages site: import a NEW mid-size town → progress bar runs → streets load → generate a route → download GPX → mark run complete. Check the Railway logs show no errors.

---

## Final Verification (whole-plan acceptance)

- [ ] `rtk npm test` in `server/` — all three test files pass.
- [ ] `rtk npx tsc --noEmit` clean in both `server/` and `web/`.
- [ ] Whole-city import: search a real city ~40–60 km across (e.g. "Denver"). Progress bar counts tiles to completion (this may take several minutes — Overpass rate limits apply); streets render; generate a route; mark a run; heatmap updates.
- [ ] Restart the server mid-import → job flips to error with "The server restarted mid-import — please retry."; re-searching starts a fresh job.
- [ ] `rtk git log --oneline` shows one commit per task.

## Spec deviations (intentional, minor)

1. **Geocode-miss errors surface as an immediate 400** from `POST /api/area` instead of a job error (spec §4 table) — strictly better UX; the worker's geocode phase remains as a safety net.
2. **Coordinate rounding and cache eviction** (spec §3.4 "Hardening") land in Task 5 with the worker/cache code they belong to; Task 8 covers the remaining hardening (rate limits, compression).
3. **The UI "Retry button"** (spec §3.2) is the existing "Find streets" button, re-enabled on error with the message telling the user to click it — it re-submits the search and creates a fresh job, which is exactly the specified behavior without a second button.
