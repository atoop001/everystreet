// OSM data access.
// Phase 1 (development): live Nominatim geocoding + Overpass street fetch,
// cached permanently in the database so each area is fetched ONCE.
// Phase 4 (production/scale): swap fetchStreets to read from self-hosted
// Geofabrik extracts, and geocode() to Geoapify/LocationIQ — the function
// signatures stay identical, so nothing else changes.

import { haversine } from './engine.js';
import { tileGrid, dedupeElements, type BBox } from './tiles.js';

const UA = 'EveryStreetApp/0.1 (development)';

export interface GeoResult {
  lat: number; lon: number;
  bbox: [number, number, number, number]; // south, north, west, east
  displayName: string;
}

export async function geocode(query: string): Promise<GeoResult> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
  const data = (await res.json()) as any[];
  if (!data.length) throw new Error('Location not found — try being more specific.');
  const r = data[0];
  const bb = r.boundingbox.map(Number) as [number, number, number, number];
  return { lat: +r.lat, lon: +r.lon, bbox: bb, displayName: r.display_name };
}

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
