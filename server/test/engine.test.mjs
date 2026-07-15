// Engine test: builds a synthetic street grid, generates two sequential
// routes, and asserts budget adherence, path continuity, and that run 2
// prefers streets run 1 didn't cover.
// Run with: npm test   (from the server folder)

import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Transpile engine.ts on the fly via tsx-compatible dynamic import.
const engineUrl = pathToFileURL(join(here, '../src/engine.ts')).href;
let engine;
try {
  engine = await import(engineUrl); // works when run through tsx
} catch {
  // Fallback: strip types crudely is unsafe; instead instruct.
  console.error('Run this test via: npx tsx test/engine.test.mjs');
  process.exit(1);
}

const { buildGraph, generateRoute, haversine, pickStart } = engine;

function makeGridElements(n, spacing) {
  const elements = [];
  let wayId = 1;
  const nodeId = (r, c) => r * 100 + c;
  const coord = (r, c) => ({ lat: 37.0 + r * spacing, lon: -122.0 + c * spacing });
  for (let r = 0; r < n; r++) {
    const nodes = [], geometry = [];
    for (let c = 0; c < n; c++) { nodes.push(nodeId(r, c)); geometry.push(coord(r, c)); }
    elements.push({ type: 'way', id: wayId++, nodes, geometry, tags: { name: 'Row ' + r } });
  }
  for (let c = 0; c < n; c++) {
    const nodes = [], geometry = [];
    for (let r = 0; r < n; r++) { nodes.push(nodeId(r, c)); geometry.push(coord(r, c)); }
    elements.push({ type: 'way', id: wayId++, nodes, geometry, tags: { name: 'Col ' + c } });
  }
  return elements;
}

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  ✓', msg);
  else { console.error('  ✗ FAIL:', msg); failures++; }
};

const graph = buildGraph(makeGridElements(5, 0.002)); // 5x5, ~222 m blocks
console.log('Graph: ' + graph.nodes.size + ' nodes, ' + graph.edges.size + ' edges');
assert(graph.nodes.size === 25 && graph.edges.size === 40, 'grid graph has expected shape');

const budget = 3000;
const visited = new Set();
const start = pickStart(graph, 37.0, -122.0, visited);
assert(start !== null, 'start node picked');

const r1 = generateRoute(graph, start, budget, { loop: true }, visited);
assert(r1.totalDist > budget * 0.7 && r1.totalDist < budget * 1.25, `run 1 near budget (${r1.totalDist.toFixed(0)} m vs ${budget})`);
assert(r1.newStreetDist === r1.totalDist, 'run 1 is 100% new streets');

let maxJump = 0;
for (let i = 1; i < r1.coords.length; i++) {
  maxJump = Math.max(maxJump, haversine(r1.coords[i - 1][0], r1.coords[i - 1][1], r1.coords[i][0], r1.coords[i][1]));
}
assert(maxJump < 250, `route is continuous (max gap ${maxJump.toFixed(0)} m ≤ one block)`);

r1.edgeIds.forEach(id => visited.add(id));
const r2 = generateRoute(graph, start, budget, { loop: true }, visited);
const pctNew = r2.totalDist ? r2.newStreetDist / r2.totalDist : 0;
assert(pctNew > 0.5, `run 2 mostly new streets (${(pctNew * 100).toFixed(0)}% new)`);

r2.edgeIds.forEach(id => visited.add(id));
let total = 0, done = 0;
graph.edges.forEach((e, id) => { total += e.length; if (visited.has(id)) done += e.length; });
console.log(`Coverage after 2 runs: ${(100 * done / total).toFixed(1)}%`);
assert(done / total > 0.25, 'meaningful coverage after two runs');

// Exhaustion test: keep running until covered or stalled.
let runs = 2, stalled = 0;
while (done / total < 0.999 && runs < 30 && stalled < 3) {
  const r = generateRoute(graph, start, budget, { loop: true }, visited);
  const before = visited.size;
  r.edgeIds.forEach(id => visited.add(id));
  if (visited.size === before) stalled++; else stalled = 0;
  runs++;
  done = 0; graph.edges.forEach((e, id) => { if (visited.has(id)) done += e.length; });
}
console.log(`Full coverage reached in ${runs} runs: ${(100 * done / total).toFixed(1)}%`);
assert(done / total > 0.95, 'engine can cover (nearly) every street across repeated runs');

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('ALL TESTS PASSED');
