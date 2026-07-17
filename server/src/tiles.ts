// Pure tile-grid math for splitting an area bbox into Overpass-sized
// queries, plus cross-tile dedupe. Kept free of I/O so it's unit-testable.

export type BBox = [number, number, number, number]; // south, north, west, east

const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON_EQUATOR = 111.32;

export function tileGrid(bbox: BBox, tileKm: number): BBox[] {
  const [south, north, west, east] = bbox;
  const latStep = tileKm / KM_PER_DEG_LAT;
  const midLat = (south + north) / 2;
  // lonStep uses the whole-bbox midpoint latitude — an intentional
  // approximation, fine at the ≤60 km spans this app allows.
  const kmPerDegLon = KM_PER_DEG_LON_EQUATOR * Math.cos((midLat * Math.PI) / 180);
  const lonStep = tileKm / Math.max(kmPerDegLon, 1e-6);
  // Count tiles per axis with a 5% tolerance so a span just over a whole
  // number of steps doesn't spawn a near-zero "sliver" row/column, then
  // divide the span evenly: every tile is the same size (within ~5% of
  // tileKm) and the outer edges land exactly on the bbox.
  const rows = Math.max(1, Math.ceil((north - south) / latStep - 0.05));
  const cols = Math.max(1, Math.ceil((east - west) / lonStep - 0.05));
  const tiles: BBox[] = [];
  for (let r = 0; r < rows; r++) {
    const s = south + ((north - south) * r) / rows;
    const n = r === rows - 1 ? north : south + ((north - south) * (r + 1)) / rows;
    for (let c = 0; c < cols; c++) {
      const w = west + ((east - west) * c) / cols;
      const e = c === cols - 1 ? east : west + ((east - west) * (c + 1)) / cols;
      tiles.push([s, n, w, e]);
    }
  }
  return tiles;
}

export function dedupeElements<T extends { id: number }>(elements: T[]): T[] {
  const seen = new Set<number>();
  const out: T[] = [];
  for (const el of elements) {
    if (!seen.has(el.id)) { seen.add(el.id); out.push(el); }
  }
  return out;
}
