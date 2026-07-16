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
