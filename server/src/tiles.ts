// Pure tile-grid math for splitting an area bbox into Overpass-sized
// queries, plus cross-tile dedupe. Kept free of I/O so it's unit-testable.

export type BBox = [number, number, number, number]; // south, north, west, east

const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON_EQUATOR = 111.32;

export function tileGrid(bbox: BBox, tileKm: number): BBox[] {
  const [south, north, west, east] = bbox;
  const latStep = tileKm / KM_PER_DEG_LAT;
  const midLat = (south + north) / 2;
  const kmPerDegLon = KM_PER_DEG_LON_EQUATOR * Math.cos((midLat * Math.PI) / 180);
  const lonStep = tileKm / Math.max(kmPerDegLon, 1e-6);
  const tiles: BBox[] = [];
  for (let s = south; s < north; s += latStep) {
    const n = Math.min(s + latStep, north);
    for (let w = west; w < east; w += lonStep) {
      tiles.push([s, n, w, Math.min(w + lonStep, east)]);
    }
  }
  return tiles.length ? tiles : [bbox];
}

export function dedupeElements<T extends { id: number }>(elements: T[]): T[] {
  const seen = new Set<number>();
  const out: T[] = [];
  for (const el of elements) {
    if (!seen.has(el.id)) { seen.add(el.id); out.push(el); }
  }
  return out;
}
