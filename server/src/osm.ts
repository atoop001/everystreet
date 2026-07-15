// OSM data access.
// Phase 1 (development): live Nominatim geocoding + Overpass street fetch,
// cached permanently in the database so each area is fetched ONCE.
// Phase 4 (production/scale): swap fetchStreets to read from self-hosted
// Geofabrik extracts, and geocode() to Geoapify/LocationIQ — the function
// signatures stay identical, so nothing else changes.

import { haversine } from './engine.js';

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

// The public Overpass instance is a dev-only stopgap (see file header) —
// it reliably times out (504) on whole-city queries regardless of retries,
// so this cap keeps imports to a size it can actually finish in one query.
const MAX_DIAGONAL_M = 12000;

export async function fetchStreets(bbox: [number, number, number, number], includePaths: boolean) {
  const [south, north, west, east] = bbox;
  const diag = haversine(south, west, north, east);
  if (diag > MAX_DIAGONAL_M) {
    throw new Error(`That area is ${(diag / 1000).toFixed(0)} km across — too large for one import (limit ~${MAX_DIAGONAL_M / 1000} km). Try a neighborhood or small town instead of a whole city.`);
  }
  const types = includePaths
    ? 'primary|secondary|tertiary|unclassified|residential|living_street|pedestrian|footway|path|cycleway'
    : 'primary|secondary|tertiary|unclassified|residential|living_street|pedestrian';
  const q = `[out:json][timeout:60];way["highway"~"^(${types})$"]["area"!~"yes"](${south},${west},${north},${east});out geom;`;
  let res: Response;
  try {
    res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST', body: q, headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(75_000)
    });
  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error('Street data request timed out — try a smaller area (a neighborhood, not a whole city).');
    }
    throw err;
  }
  if (!res.ok) {
    const busy = res.status === 429 || res.status === 504;
    throw new Error(busy
      ? `Street data fetch failed (${res.status}) — either Overpass is briefly overloaded (retry in a minute) or this area is too large for it to finish in time (try something smaller).`
      : `Street data fetch failed (${res.status}).`);
  }
  const json = (await res.json()) as { elements?: any[] };
  if (!json.elements?.length) throw new Error('No streets found in that area.');
  return json.elements;
}
