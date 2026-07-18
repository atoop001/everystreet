// Background street-import worker: an async loop inside the single server
// process. Polls import_jobs for queued work (so queued jobs survive a
// restart), processes ONE job at a time, and records progress per tile.
// Imports are all-or-nothing: any failure marks the job error and saves
// nothing. Sub-project 3's coverage-plan computation will reuse this shape.
import * as store from './db.js';
import { geocode, fetchStreets } from './osm.js';
import { buildGraph, graphFromRows } from './engine.js';
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
  try {
    await store.deleteOldJobs();
  } catch (err) {
    console.error('Import worker: old-job pruning failed:', err);
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
    // Prime the cache from the rounded rows so it matches what a restart would rebuild from the DB.
    putGraph(job.slug, graphFromRows(streets));
    await store.updateJob(job.id, { status: 'done', phase: 'done', area_id: area.id });
  } catch (err: any) {
    await store.updateJob(job.id, {
      status: 'error',
      error: err?.message || 'Import failed.'
    }).catch(e => console.error('Could not record job failure:', e));
  }
}
