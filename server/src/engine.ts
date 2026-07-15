// Street graph construction + route generation engine.
// Ported from the validated prototype; runs server-side so it can
// handle whole cities.

export interface Edge {
  id: string;
  coords: [number, number][]; // [lat, lon]
  length: number;             // meters
  name: string;
  from: number;               // OSM node id
  to: number;
}
export interface Graph {
  nodes: Map<number, { lat: number; lon: number }>;
  adj: Map<number, { edgeId: string; to: number; dist: number }[]>;
  edges: Map<string, Edge>;
}
export interface RouteResult {
  coords: [number, number][];
  edgeIds: string[];
  totalDist: number;
  newStreetDist: number;
}

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

class MinHeap<T> {
  private a: { item: T; priority: number }[] = [];
  size() { return this.a.length; }
  push(item: T, priority: number) {
    this.a.push({ item, priority });
    let i = this.a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.a[p].priority <= this.a[i].priority) break;
      [this.a[p], this.a[i]] = [this.a[i], this.a[p]]; i = p;
    }
  }
  pop() {
    const top = this.a[0]; const last = this.a.pop()!;
    if (this.a.length) {
      this.a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = 2 * i + 2; let s = i;
        if (l < this.a.length && this.a[l].priority < this.a[s].priority) s = l;
        if (r < this.a.length && this.a[r].priority < this.a[s].priority) s = r;
        if (s === i) break;
        [this.a[s], this.a[i]] = [this.a[i], this.a[s]]; i = s;
      }
    }
    return top;
  }
}

interface OSMWay {
  type: string; id: number;
  nodes?: number[];
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

/** Build an intersection graph from raw Overpass way elements. */
export function buildGraph(elements: OSMWay[]): Graph {
  const ways = elements.filter(e => e.type === 'way' && e.geometry && e.nodes && e.nodes.length > 1) as Required<OSMWay>[];
  const nodeUse = new Map<number, number>();
  ways.forEach(w => w.nodes.forEach(id => nodeUse.set(id, (nodeUse.get(id) || 0) + 1)));
  const splitPoints = new Set<number>();
  ways.forEach(w => { splitPoints.add(w.nodes[0]); splitPoints.add(w.nodes[w.nodes.length - 1]); });
  nodeUse.forEach((c, id) => { if (c > 1) splitPoints.add(id); });

  const nodes = new Map<number, { lat: number; lon: number }>();
  const adj = new Map<number, { edgeId: string; to: number; dist: number }[]>();
  const edges = new Map<string, Edge>();

  ways.forEach(w => {
    let segCoords: [number, number][] = [], segStartIdx = 0, segIdx = 0;
    for (let i = 0; i < w.nodes.length; i++) {
      const g = w.geometry[i]; if (!g) continue;
      const nid = w.nodes[i];
      nodes.set(nid, { lat: g.lat, lon: g.lon });
      segCoords.push([g.lat, g.lon]);
      if (splitPoints.has(nid) && i > segStartIdx) {
        const fromId = w.nodes[segStartIdx], toId = nid;
        let length = 0;
        for (let k = 1; k < segCoords.length; k++)
          length += haversine(segCoords[k - 1][0], segCoords[k - 1][1], segCoords[k][0], segCoords[k][1]);
        if (length > 1) {
          const edgeId = 'w' + w.id + '_' + (segIdx++);
          edges.set(edgeId, { id: edgeId, coords: segCoords.slice(), length, name: w.tags?.name || '', from: fromId, to: toId });
          if (!adj.has(fromId)) adj.set(fromId, []);
          if (!adj.has(toId)) adj.set(toId, []);
          adj.get(fromId)!.push({ edgeId, to: toId, dist: length });
          adj.get(toId)!.push({ edgeId, to: fromId, dist: length });
        }
        segStartIdx = i;
        segCoords = [[g.lat, g.lon]];
      }
    }
  });
  return { nodes, adj, edges };
}

/** Rebuild a Graph from street rows loaded out of the database. */
export function graphFromRows(rows: { edge_id: string; name: string; length_m: number; from_node: number; to_node: number; coords: [number, number][] }[]): Graph {
  const nodes = new Map<number, { lat: number; lon: number }>();
  const adj = new Map<number, { edgeId: string; to: number; dist: number }[]>();
  const edges = new Map<string, Edge>();
  for (const r of rows) {
    const e: Edge = { id: r.edge_id, coords: r.coords, length: r.length_m, name: r.name, from: Number(r.from_node), to: Number(r.to_node) };
    edges.set(e.id, e);
    const first = e.coords[0], last = e.coords[e.coords.length - 1];
    nodes.set(e.from, { lat: first[0], lon: first[1] });
    nodes.set(e.to, { lat: last[0], lon: last[1] });
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from)!.push({ edgeId: e.id, to: e.to, dist: e.length });
    adj.get(e.to)!.push({ edgeId: e.id, to: e.from, dist: e.length });
  }
  return { nodes, adj, edges };
}

function dijkstraFrom(graph: Graph, startId: number) {
  const dist = new Map<number, number>([[startId, 0]]);
  const prevEdge = new Map<number, { from: number; edgeId: string }>();
  const seen = new Set<number>();
  const heap = new MinHeap<number>();
  heap.push(startId, 0);
  while (heap.size()) {
    const { item: u, priority: d } = heap.pop();
    if (seen.has(u)) continue;
    seen.add(u);
    if (d > (dist.get(u) ?? Infinity)) continue;
    for (const { edgeId, to, dist: w } of graph.adj.get(u) || []) {
      const nd = d + w;
      if (!dist.has(to) || nd < dist.get(to)! - 1e-9) {
        dist.set(to, nd);
        prevEdge.set(to, { from: u, edgeId });
        heap.push(to, nd);
      }
    }
  }
  return { dist, prevEdge };
}

function pathTo(prevEdge: Map<number, { from: number; edgeId: string }>, startId: number, targetId: number): string[] | null {
  if (startId === targetId) return [];
  const out: string[] = []; let cur = targetId;
  while (cur !== startId) {
    const p = prevEdge.get(cur);
    if (!p) return null;
    out.push(p.edgeId);
    cur = p.from;
  }
  return out.reverse();
}

const same = (a: [number, number], b: [number, number]) =>
  Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

/**
 * Greedy coverage route: repeatedly walk to the nearest street not yet
 * used this run, preferring streets never covered by this user, until
 * the distance budget is spent; optionally loop back to start.
 */
export function generateRoute(
  graph: Graph, startId: number, budgetMeters: number,
  opts: { loop: boolean }, globalVisited: Set<string>
): RouteResult {
  const runUsed = new Set<string>();
  let current = startId;
  let remaining = budgetMeters;
  const routeCoords: [number, number][] = [];
  const routeEdgeIds: string[] = [];
  let totalDist = 0, newStreetDist = 0;

  const traverse = (edgeId: string, fromId: number) => {
    const e = graph.edges.get(edgeId)!;
    let coords = e.coords;
    if (e.from !== fromId) coords = coords.slice().reverse();
    if (routeCoords.length && same(routeCoords[routeCoords.length - 1], coords[0])) coords = coords.slice(1);
    routeCoords.push(...coords);
    routeEdgeIds.push(edgeId);
    totalDist += e.length; remaining -= e.length;
    if (!globalVisited.has(edgeId)) newStreetDist += e.length;
    runUsed.add(edgeId);
    current = fromId === e.from ? e.to : e.from;
  };

  // Reserve distance to get home if looping.
  const homeReserve = opts.loop ? 0.0 : 0; // return handled with tolerance below
  let guard = 0;
  const maxGuard = Math.min(6000, Math.max(200, Math.round(budgetMeters / 8)));
  while (remaining > budgetMeters * 0.03 && guard < maxGuard) {
    guard++;
    const { dist, prevEdge } = dijkstraFrom(graph, current);
    const distHome = opts.loop ? dijkstraFrom(graph, startId).dist : null;
    let best: { id: string; approach: number; entry: number; isNew: boolean } | null = null;
    graph.edges.forEach((e, id) => {
      if (runUsed.has(id)) return;
      const dFrom = dist.get(e.from), dTo = dist.get(e.to);
      if (dFrom === undefined && dTo === undefined) return;
      const useFrom = (dFrom ?? Infinity) <= (dTo ?? Infinity);
      const approach = (useFrom ? dFrom : dTo)!;
      const entry = useFrom ? e.from : e.to;
      const exit = useFrom ? e.to : e.from;
      let cost = approach + e.length;
      if (opts.loop && distHome) {
        const back = distHome.get(exit);
        if (back !== undefined) cost += back * 0.35; // soft reserve for the trip home
      }
      if (cost <= remaining + homeReserve + 1e-6) {
        const isNew = !globalVisited.has(id);
        if (!best || (isNew && !best.isNew) || (isNew === best.isNew && approach < best.approach)) {
          best = { id, approach, entry, isNew };
        }
      }
    });
    if (!best) break;
    const b = best as { id: string; approach: number; entry: number; isNew: boolean };
    const pathEdges = pathTo(prevEdge, current, b.entry);
    if (pathEdges === null) break;
    for (const eId of pathEdges) traverse(eId, current);
    traverse(b.id, current);
  }

  if (opts.loop && current !== startId) {
    const { dist, prevEdge } = dijkstraFrom(graph, current);
    const backDist = dist.get(startId);
    if (backDist !== undefined && backDist <= remaining + budgetMeters * 0.2 + 1) {
      const pathEdges = pathTo(prevEdge, current, startId);
      if (pathEdges) for (const eId of pathEdges) traverse(eId, current);
    }
  }

  return { coords: routeCoords, edgeIds: routeEdgeIds, totalDist, newStreetDist };
}

/** Pick a start node adjacent to uncovered streets, nearest to a point. */
export function pickStart(graph: Graph, lat: number, lon: number, covered: Set<string>): number | null {
  // Prefer nodes touching at least one uncovered edge.
  let best: number | null = null, bestD = Infinity;
  let fallback: number | null = null, fallbackD = Infinity;
  graph.nodes.forEach((pos, id) => {
    const neigh = graph.adj.get(id);
    if (!neigh || !neigh.length) return;
    const d = haversine(pos.lat, pos.lon, lat, lon);
    if (d < fallbackD) { fallbackD = d; fallback = id; }
    if (neigh.some(n => !covered.has(n.edgeId)) && d < bestD) { bestD = d; best = id; }
  });
  return best ?? fallback;
}
