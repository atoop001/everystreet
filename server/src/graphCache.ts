// In-memory route-graph cache, shared by the API and the import worker.
// Eviction is by total edge count, not area count: a whole city is 50k+
// edges while a neighborhood is a few hundred, so edges are the honest
// memory proxy. Requires a single server instance (see deploy notes).
import { graphFromRows, type Graph } from './engine.js';
import * as store from './db.js';
import type { AreaRow } from './db.js';

const maxEdges = () => {
  const n = Number(process.env.GRAPH_CACHE_MAX_EDGES);
  return Number.isFinite(n) && n > 0 ? n : 500_000;
};
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
