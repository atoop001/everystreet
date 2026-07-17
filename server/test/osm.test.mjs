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

// -- fail-fast stops the sibling worker: no further tiles pulled, no late progress --
{
  // 2×2 grid (~8 km × ~8 km at 37°N) → 4 tiles, concurrency 2.
  const fourTileBbox = [37.0, 37.0724, -122.0, -121.91];
  const progress = [];
  let calls = 0;
  const mock = async () => { calls++; return busy; };
  let threw = null;
  try {
    await fetchStreets(fourTileBbox, false,
      (done, total) => progress.push([done, total]), { fetchImpl: mock, ...NO_BACKOFF });
  } catch (e) { threw = e; }
  // Promise.all rejects while the sibling's last retry is still queued on a
  // timer — flush pending timers so the final call count is stable.
  await new Promise(r => setTimeout(r, 100));
  assert(threw !== null, 'import fails when tiles fail');
  assert(calls === 6, `only the 2 in-flight tiles retried (3 attempts each), no new tiles pulled after abort (got ${calls} calls)`);
  assert(progress.length === 0, 'no progress callbacks after failure');
}

process.exit(failures ? 1 : 0);
