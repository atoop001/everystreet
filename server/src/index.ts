import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { buildGraph, graphFromRows, generateRoute, pickStart, type Graph } from './engine.js';
import { geocode, fetchStreets } from './osm.js';
import * as store from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';
import { toGPX } from './gpx.js';

const app = express();
app.use(cors({ origin: process.env.WEB_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({ limit: '2mb' }));

const slugify = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'area';

// In-memory graph cache (graphs are expensive to rebuild per request).
const graphCache = new Map<string, Graph>();
async function loadGraph(area: store.AreaRow): Promise<Graph> {
  const hit = graphCache.get(area.slug);
  if (hit) return hit;
  const rows = await store.getStreets(area.id);
  const g = graphFromRows(rows);
  if (graphCache.size > 20) graphCache.delete(graphCache.keys().next().value!); // simple LRU-ish cap
  graphCache.set(area.slug, g);
  return g;
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

/** Search / import an area. Cached in DB after first import. */
app.post('/api/area', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const { query, includePaths } = req.body as { query: string; includePaths?: boolean };
    if (!query?.trim()) return res.status(400).json({ error: 'Enter a city or neighborhood.' });
    const slug = slugify(query) + (includePaths ? '-paths' : '');
    let area = await store.getArea(slug);
    if (!area) {
      const geo = await geocode(query);
      const elements = await fetchStreets(geo.bbox, !!includePaths);
      const graph = buildGraph(elements);
      if (!graph.edges.size) return res.status(404).json({ error: 'No usable streets found there.' });
      let total = 0;
      const streets = [...graph.edges.values()].map(e => {
        total += e.length;
        return { edge_id: e.id, name: e.name, length_m: e.length, from_node: e.from, to_node: e.to, coords: e.coords };
      });
      area = await store.saveArea({
        slug, label: geo.displayName,
        bbox: geo.bbox, center: [geo.lat, geo.lon],
        street_count: graph.edges.size, total_length_m: total
      }, streets);
      graphCache.set(slug, graph);
    }
    const graph = await loadGraph(area);
    const covered = await store.getCovered(req.userId!, area.slug);
    const streets = [...graph.edges.values()].map(e => ({
      id: e.id, name: e.name, length: e.length, coords: e.coords,
      times: covered.get(e.id) || 0
    }));
    res.json({ area, streets });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Area import failed.' });
  }
});

/** Generate a route. */
app.post('/api/route', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const { areaSlug, budgetMeters, loop, start } = req.body as {
      areaSlug: string; budgetMeters: number; loop: boolean;
      start?: { lat: number; lon: number } | null;
    };
    const area = await store.getArea(areaSlug);
    if (!area) return res.status(404).json({ error: 'Area not found — search it first.' });
    if (!budgetMeters || budgetMeters < 200) return res.status(400).json({ error: 'Distance is too short.' });
    if (budgetMeters > 80000) return res.status(400).json({ error: 'Distance limit is 80 km per route.' });
    const graph = await loadGraph(area);
    const coveredMap = await store.getCovered(req.userId!, area.slug);
    const covered = new Set(coveredMap.keys());
    const anchor = start ?? { lat: area.center[0], lon: area.center[1] };
    const startId = pickStart(graph, anchor.lat, anchor.lon, covered);
    if (startId == null) return res.status(400).json({ error: 'No routable start point found.' });
    const route = generateRoute(graph, startId, budgetMeters, { loop: !!loop }, covered);
    if (route.coords.length < 2) return res.status(422).json({ error: 'Could not build a route here — try another start or longer distance.' });
    const startPos = graph.nodes.get(startId)!;
    res.json({
      coords: route.coords,
      edgeIds: route.edgeIds,
      totalDist: route.totalDist,
      newStreetDist: route.newStreetDist,
      start: [startPos.lat, startPos.lon]
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Route generation failed.' });
  }
});

/** Download a route (posted coords) as GPX. */
app.post('/api/gpx', requireAuth, (req: AuthedRequest, res) => {
  const { coords, name } = req.body as { coords: [number, number][]; name?: string };
  if (!coords?.length) return res.status(400).json({ error: 'No route to export.' });
  const title = name || 'Every Street run ' + new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/gpx+xml');
  res.setHeader('Content-Disposition', `attachment; filename="${title.replace(/[^a-z0-9]+/gi, '_')}.gpx"`);
  res.send(toGPX(coords, title));
});

/** Mark a route as completed: stores the run and updates coverage. */
app.post('/api/runs', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const { areaSlug, coords, edgeIds, totalDist, newStreetDist } = req.body as {
      areaSlug: string; coords: [number, number][]; edgeIds: string[];
      totalDist: number; newStreetDist: number;
    };
    const area = await store.getArea(areaSlug);
    if (!area) return res.status(404).json({ error: 'Area not found.' });
    if (!coords?.length || !edgeIds?.length) return res.status(400).json({ error: 'No route data.' });
    await store.markCovered(req.userId!, area.slug, edgeIds);
    const saved = await store.saveRun(req.userId!, area.id, {
      distance_m: totalDist, new_distance_m: newStreetDist,
      coords: coords.map(c => [Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5] as [number, number])
    });
    res.json({ ok: true, run: saved });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Could not save run.' });
  }
});

app.get('/api/runs', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const areaSlug = String(req.query.areaSlug || '');
    const area = await store.getArea(areaSlug);
    if (!area) return res.json({ runs: [] });
    res.json({ runs: await store.listRuns(req.userId!, area.id) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/runs/:id/gpx', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const run = await store.getRun(req.userId!, req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found.' });
    const title = 'Run ' + new Date(run.created_at).toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/gpx+xml');
    res.setHeader('Content-Disposition', `attachment; filename="${title.replace(/[^a-z0-9]+/gi, '_')}.gpx"`);
    res.send(toGPX(run.coords, title));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const port = Number(process.env.PORT || 3001);
app.listen(port, () => console.log(`Every Street server → http://localhost:${port}`));
