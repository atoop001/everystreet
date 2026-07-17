import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import { generateRoute, pickStart, haversine } from './engine.js';
import { geocode } from './osm.js';
import { loadGraph } from './graphCache.js';
import { startImportWorker } from './importWorker.js';
import * as store from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';
import { toGPX } from './gpx.js';

const app = express();
// Behind Railway's proxy in production; needed for real client IPs.
app.set('trust proxy', 1);
// CORS first: even rate-limited (429) responses need CORS headers for the browser to read them.
app.use(cors({ origin: process.env.WEB_ORIGIN || 'http://localhost:5173' }));
app.use(compression());
// Job polling fires every 2 s for many minutes during a city import, so it
// gets its own generous budget instead of a blanket exemption.
app.use('/api/area/jobs/', rateLimit({
  windowMs: 15 * 60 * 1000, limit: 2000,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests — slow down and try again shortly.' }
}));
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000, limit: 300,
  standardHeaders: true, legacyHeaders: false,
  // /area/jobs/ is budgeted by its own limiter above, not exempted entirely.
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
app.use(express.json({ limit: '2mb' }));

const slugify = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'area';

app.get('/api/health', (_req, res) => res.json({ ok: true }));

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
    // Only genuinely-new imports consume the strict budget.
    importLimiter(req, res, () => {
      void (async () => {
        try {
          // Fail fast BEFORE creating a job: bad locations and oversized
          // areas get an immediate 4xx. (The worker geocodes again — one
          // extra Nominatim call per brand-new area, well within its 1
          // req/s policy.)
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
  } catch (err: any) {
    res.status(err?.message?.includes('not found') ? 404 : 500)
      .json({ error: err.message || 'Area import failed.' });
  }
});

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

startImportWorker();

const port = Number(process.env.PORT || 3001);
app.listen(port, () => console.log(`Every Street server → http://localhost:${port}`));
