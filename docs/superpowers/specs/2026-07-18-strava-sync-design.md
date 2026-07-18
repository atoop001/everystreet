# Sub-project 2: Strava Auto-Sync — Design Spec

**Date:** 2026-07-18
**Status:** Approved design, awaiting implementation plan
**Depends on:** Sub-project 1 (scale-core) — reuses its job-queue pattern,
graph cache, and deployment (Railway public URL for the webhook).

---

## 1. Problem

Coverage today only updates when a user clicks "Mark run complete" on an
app-generated route. Real runners record on Strava. Auto-sync makes the
coverage map reflect what they actually ran: connect once, and every past
and future on-foot activity is map-matched onto imported street graphs
and credited automatically.

Decisions locked with the owner:
- Synced GPS tracks are **map-matched to streets** and credit coverage
  directly (no manual confirm step; "Mark run complete" remains for
  app-generated routes but becomes unnecessary for synced users).
- On connect, **backfill the last 2 years** of history.
- **Runs + walks + hikes** count; rides and other sports do not.
- New activities arrive via **Strava webhook** (with a sign-in sweep as
  the dev/reliability fallback).
- Activities in areas with no imported street data are **stored + hinted**
  ("N runs in places you haven't imported — try searching 'Boulder, CO'")
  and credited retroactively when the area is imported.

## 2. Non-goals

- Garmin sync (Phase 3 second half; requires Garmin's business program).
- Club/social features (owner-excluded).
- Posting anything TO Strava (read-only integration).
- External map-matching services (OSRM/Mapbox) — coverage requires OUR
  edge ids, so we match against our own graph.
- Multi-athlete capacity on day one: new Strava API apps are limited to
  the owning athlete until Strava approves a capacity-increase request.
  The feature ships fully functional for the owner; club members connect
  once Strava raises the cap. Submit the request early.

## 3. Architecture (Approach A — all in the existing Express server)

New server modules, mirroring sub-project 1's proven shapes:

- `server/src/strava.ts` — OAuth token exchange/refresh, paced API
  client (activity list, activity streams, deauthorize), webhook
  subscription helpers. All Strava HTTP goes through one wrapper.
- `server/src/matcher.ts` — PURE map-matching: (track, Graph) →
  covered edge ids. No I/O; unit-tested like `tiles.ts`.
- `server/src/syncWorker.ts` — second in-process worker loop (claim /
  poll 2 s / crash recovery / one job at a time), processing `sync_jobs`.
- Routes in `server/src/index.ts`: connect, callback, disconnect,
  status, webhook (POST + GET challenge), sync-check.
- Web: a Strava card in the sidebar (connect state, backfill progress
  bar reusing the import-progress pattern, unmatched-areas hint card);
  run history shows synced activities merged with app runs by date.

Single-instance constraint unchanged (in-process workers + graph cache).

## 4. Data model (append to `supabase/schema.sql`; all tables RLS-enabled + service_role grants)

```sql
-- Strava OAuth accounts. RLS with NO client policies: tokens are secrets;
-- only the server (service_role, bypasses RLS) reads them.
create table if not exists strava_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  athlete_id bigint unique not null,
  athlete_name text not null default '',
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  scope text not null default '',
  needs_reauth boolean not null default false,
  connected_at timestamptz not null default now()
);

-- One-time OAuth state tokens (connect flow CSRF protection).
create table if not exists strava_oauth_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  consumed boolean not null default false
);

-- Synced activities. strava_id unique = idempotency anchor.
create table if not exists activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  strava_id bigint unique not null,
  type text not null,                    -- Run | Walk | Hike
  name text not null default '',
  started_at timestamptz not null,
  distance_m real not null default 0,
  track jsonb,                           -- [[lat,lon],...] or null (no GPS)
  track_bbox jsonb,                      -- [south,north,west,east] or null
  status text not null default 'pending'
    check (status in ('pending','matched','unmatched_area','no_gps')),
  place_hint text,                       -- reverse-geocoded once, for the hint card
  created_at timestamptz not null default now()
);
create index if not exists activities_user_idx on activities(user_id, started_at desc);

-- Which activity credited which area — makes crediting idempotent so
-- re-syncs and retroactive passes never double-count coverage.
create table if not exists activity_areas (
  activity_id uuid not null references activities(id) on delete cascade,
  area_id uuid not null references areas(id) on delete cascade,
  edges_credited int not null default 0,
  credited_at timestamptz not null default now(),
  primary key (activity_id, area_id)
);

-- Sync jobs: clone of the import_jobs pattern.
create table if not exists sync_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('backfill','activity')),
  strava_activity_id bigint,             -- for kind='activity'
  status text not null default 'queued'
    check (status in ('queued','running','done','error')),
  progress int not null default 0,       -- activities processed
  total int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists sync_jobs_active_backfill
  on sync_jobs(user_id) where status in ('queued','running') and kind = 'backfill';
```

Client-readable via RLS policies: `activities` (own rows, select),
`sync_jobs` (own rows, select). Everything else server-only. Server-side
polling endpoints remain the primary read path, matching sub-project 1.

## 5. OAuth flow

1. `POST /api/strava/connect` (authed) → creates a state row, returns the
   Strava authorize URL (`activity:read_all`, `redirect_uri` =
   `{API_URL}/api/strava/callback`).
2. Browser → Strava → `GET /api/strava/callback?code&state`. Server
   validates + consumes the state row, exchanges the code (client id +
   secret), upserts `strava_accounts`, enqueues a `backfill` sync job,
   redirects to `{WEB_ORIGIN}?strava=connected`.
3. Token refresh: the API wrapper refreshes when `expires_at` is near,
   persisting new tokens. Refresh failure → `needs_reauth = true`; UI
   shows "Reconnect Strava".
4. `POST /api/strava/disconnect` → calls Strava deauthorize, deletes the
   account row (activities and coverage remain).
5. `GET /api/strava/status` → `{connected, athleteName, needsReauth,
   backfill: {status, progress, total} | null, unmatched: [{placeHint,
   count}]}` — one endpoint drives the whole sidebar card.

Env (server): `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`,
`STRAVA_WEBHOOK_VERIFY_TOKEN`. Owner setup: create the API app at
strava.com/settings/api (callback domain = Railway host; localhost for
dev), submit the athlete-capacity request.

## 6. Matcher

`matchTrack(track: [number,number][], graph: Graph, opts?) → Set<edgeId>`

- Index track points in a spatial hash grid (cell ≈ 50 m).
- For each edge: walk its polyline sampling every ~20 m; the edge is
  covered when ≥ `MATCH_COVERAGE` (default **0.7**) of samples have a
  track point within `MATCH_RADIUS_M` (default **25 m**). Both env-tunable.
- Pure function; complexity O(edges × samples) with O(1) grid lookups —
  fine for 50k-edge city graphs.
- Activities with `trainer=true`, `manual=true`, or no latlng stream →
  status `no_gps`, never matched.

## 7. Sync pipeline (`syncWorker.ts`)

Same skeleton as the import worker (startup: fail stale `running` jobs,
prune old done/error jobs; loop: atomic claim oldest queued, process,
2 s idle poll).

**Processing one activity** (shared by both job kinds):
1. Fetch detail/streams (latlng) via the paced client.
2. Store/refresh the `activities` row (type filter: Run/Walk/Hike only;
   others are never stored).
3. Candidate areas: all imported areas whose bbox intersects
   `track_bbox` (areas are few — filter in JS).
4. For each candidate area not already in `activity_areas` for this
   activity: `loadGraph(area)` (shared cache) → `matchTrack` →
   `markCovered(user, slug, edgeIds)` → insert `activity_areas` row.
5. Status: `matched` if credited anywhere; `unmatched_area` if it has GPS
   but intersected no imported area (reverse-geocode its midpoint once
   via Nominatim → `place_hint`); `no_gps` otherwise.

**Backfill job:** page `/athlete/activities` (`after` = 2 years ago,
`per_page` 100), set `total`, process sequentially, bump `progress`.
Resume-safe: `strava_id` unique + `activity_areas` PK make reprocessing
idempotent; on restart the job re-runs and skips already-credited work.

**Webhook:** `GET /api/strava/webhook` answers Strava's `hub.challenge`
handshake (verify token check). `POST /api/strava/webhook` (no auth —
validated by object shape + known `owner_id`): activity `create`/`update`
→ upsert an `activity` sync job for that athlete's user; athlete
`deauthorize` → delete the account row. Always respond 200 fast; work
happens in the worker. One-time subscription via an npm script
(`npm run strava:subscribe`) against the deployed URL.

**Sign-in sweep (fallback):** `POST /api/strava/sync-check` (authed) —
if connected and no check in the last hour, enqueue a mini-backfill
(`after` = newest stored activity). Web calls it on app load. Covers
missed webhooks and localhost dev (no tunnel needed).

**Retroactive crediting:** when an import job completes, the import
worker enqueues `activity` sync jobs for stored activities (any user,
status `matched` or `unmatched_area`) whose `track_bbox` intersects the
new area's bbox. `activity_areas` guarantees no double-crediting.

**Rate budgeting:** the single Strava client wrapper paces calls
(≥500 ms apart), reads `X-RateLimit-Usage`/`Limit` headers (defaults
200/15 min, 2 000/day, shared across ALL users), and sleeps until the
window resets when usage crosses ~90%. Backfill progress makes the wait
visible in the UI.

## 8. Web UI

- **Strava card** (sidebar, below run history): disconnected → "Connect
  Strava" button (opens the authorize URL); connected → athlete name,
  disconnect link, backfill progress bar (poll `/api/strava/status`
  every 2 s while a backfill is active — same pattern as imports);
  `needs_reauth` → "Reconnect" button.
- **Hint card:** when `unmatched` is non-empty: "5 runs in places you
  haven't imported — try searching 'Boulder, CO'" (grouped by
  `place_hint`). Disappears as areas get imported and runs credit
  retroactively.
- **Run history:** synced activities listed with app runs, merged by
  date, tagged with a small Strava mark. Coverage/heatmap semantics
  unchanged (`covered.times` increments identically).

## 9. Error handling

| Failure | Behavior |
|---|---|
| Token refresh fails / revoked | `needs_reauth`; UI shows Reconnect; worker skips that user's jobs |
| Strava 429 / near budget | Client wrapper sleeps to window reset; job stays `running`, progress paused |
| No GPS (trainer/manual/no stream) | Activity stored `no_gps`, never matched, not shown in hints |
| Webhook missed / server down | Sign-in sweep picks it up on next app open |
| Restart mid-backfill | Stale-running recovery + re-enqueued backfill is idempotent (unique `strava_id`, `activity_areas` PK) |
| Activity in no imported area | `unmatched_area` + `place_hint`; retroactive credit on later import |
| Duplicate webhook events | Upsert semantics on `sync_jobs`/`activities` — harmless |

## 10. Testing

- **Matcher unit tests** (the bulk, pure): synthetic grid graph +
  synthetic tracks — straight run down one street covers exactly that
  street; parallel street 50 m away NOT covered; 70% threshold boundary;
  ±10 m noisy GPS still matches; empty/short tracks.
- **Mocked-fetch tests:** token refresh (expired → refreshed → persisted),
  rate-limit pause (headers near cap → client sleeps), webhook challenge
  handshake.
- **Idempotency test:** processing the same activity twice credits
  coverage once (via `activity_areas`).
- **Existing suites untouched and green.**
- **Manual verification** (owner's real Strava account, the only one that
  can connect pre-capacity-increase): connect → 2-year backfill with
  progress → heatmap lights up; record/upload a run → webhook credits it
  within minutes; a run in an un-imported town → hint card → import →
  retroactive credit.

## 11. Future seams

- `matcher.ts` is pure and graph-based → reusable by Sub-project 3's
  coverage planner (e.g., "how much of this planned run is already
  covered").
- Garmin later: same `activities`/`activity_areas`/matcher; only the
  account + fetch layer differs. Keep `strava.ts` self-contained so a
  future `garmin.ts` is a sibling, not a rewrite.
- If the club outgrows one Strava app's rate budget, the paced client is
  the single choke point to upgrade (queue priorities, nightly batch).
