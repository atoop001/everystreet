import { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { supabase, api, apiDownload } from './api';
import type { Session } from '@supabase/supabase-js';

type Street = { id: string; name: string; length: number; coords: [number, number][]; times: number };
type Area = { id: string; slug: string; label: string; bbox: [number, number, number, number]; center: [number, number]; total_length_m: number };
type Route = { coords: [number, number][]; edgeIds: string[]; totalDist: number; newStreetDist: number; start: [number, number] };
type Run = { id: string; distance_m: number; new_distance_m: number; created_at: string };
type ImportJob = { status: string; phase: string; tilesTotal: number; tilesDone: number; error: string | null; areaSlug: string };

const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

const fmt = (m: number, unit: string) =>
  unit === 'km' ? (m / 1000).toFixed(2) + ' km' : (m / 1609.344).toFixed(2) + ' mi';

/* ------------------------------------------------------------------ */
/* Auth screen                                                         */
/* ------------------------------------------------------------------ */
function AuthScreen() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState('');
  const send = async () => {
    setErr('');
    const { error } = await supabase.auth.signInWithOtp({
      email, options: { emailRedirectTo: window.location.origin }
    });
    if (error) setErr(error.message); else setSent(true);
  };
  return (
    <div className="authwrap">
      <div className="authcard">
        <p className="eyebrow">// route survey tool</p>
        <h1>Every Street</h1>
        <p className="sub">Run every street in your town — one route at a time.</p>
        {sent ? (
          <p className="sent">Check your email for a sign-in link. You can close this tab.</p>
        ) : (
          <>
            <input type="email" placeholder="you@example.com" value={email}
              onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && send()} />
            <button className="primary" onClick={send} disabled={!email.includes('@')}>
              Email me a sign-in link
            </button>
            {err && <p className="err">{err}</p>}
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Main app                                                            */
/* ------------------------------------------------------------------ */
export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!ready) return <div className="authwrap"><p className="eyebrow">loading…</p></div>;
  if (!session) return <AuthScreen />;
  return <Mapper email={session.user.email || ''} />;
}

function Mapper({ email }: { email: string }) {
  const mapDiv = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const startMarker = useRef<maplibregl.Marker | null>(null);

  const [status, setStatus] = useState('');
  const [isErr, setIsErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [includePaths, setIncludePaths] = useState(false);
  const [area, setArea] = useState<Area | null>(null);
  const [streets, setStreets] = useState<Street[]>([]);
  const [startMode, setStartMode] = useState<'auto' | 'click'>('auto');
  const [startPt, setStartPt] = useState<[number, number] | null>(null);
  const [dist, setDist] = useState('5');
  const [unit, setUnit] = useState<'mi' | 'km'>('mi');
  const [loop, setLoop] = useState(true);
  const [route, setRoute] = useState<Route | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [job, setJob] = useState<ImportJob | null>(null);

  const startModeRef = useRef(startMode);
  startModeRef.current = startMode;

  // Poll-cancellation token: bumped on every new search and on unmount so
  // an orphaned import poller stops ticking.
  const pollToken = useRef(0);
  useEffect(() => () => { pollToken.current++; }, []);

  const say = (msg: string, error = false) => { setStatus(msg); setIsErr(error); };

  /* -- map init -- */
  useEffect(() => {
    if (!mapDiv.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapDiv.current, style: MAP_STYLE,
      center: [-122.42, 37.77], zoom: 12
    });
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.on('click', e => {
      if (startModeRef.current === 'click') {
        setStartPt([e.lngLat.lat, e.lngLat.lng]);
        say('Start point set.');
      }
    });
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  /* -- draw streets layer whenever streets change -- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !streets.length) return;
    const draw = () => {
      const fc = {
        type: 'FeatureCollection' as const,
        features: streets.map(s => ({
          type: 'Feature' as const,
          properties: { times: s.times, name: s.name },
          geometry: { type: 'LineString' as const, coordinates: s.coords.map(c => [c[1], c[0]]) }
        }))
      };
      const src = map.getSource('streets') as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(fc);
      else {
        map.addSource('streets', { type: 'geojson', data: fc });
        map.addLayer({
          id: 'streets', type: 'line', source: 'streets',
          paint: {
            'line-width': 2.5,
            'line-color': ['case',
              ['>=', ['get', 'times'], 2], '#e0c34c',
              ['>=', ['get', 'times'], 1], '#6b8f71',
              '#5d6a60'
            ],
            'line-opacity': 0.9
          }
        });
      }
    };
    if (map.isStyleLoaded()) draw(); else map.once('load', draw);
  }, [streets]);

  /* -- draw route layer -- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const gj = {
      type: 'Feature' as const, properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: (route?.coords || []).map(c => [c[1], c[0]])
      }
    };
    const apply = () => {
      const src = map.getSource('route') as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(gj);
      else if (route) {
        map.addSource('route', { type: 'geojson', data: gj });
        map.addLayer({
          id: 'route', type: 'line', source: 'route',
          paint: { 'line-width': 4.5, 'line-color': '#4fb0ff', 'line-opacity': 0.95 }
        });
      }
      if (route) {
        if (startMarker.current) startMarker.current.remove();
        startMarker.current = new maplibregl.Marker({ color: '#e0c34c' })
          .setLngLat([route.start[1], route.start[0]]).addTo(map);
        const b = new maplibregl.LngLatBounds();
        route.coords.forEach(c => b.extend([c[1], c[0]]));
        map.fitBounds(b, { padding: 50 });
      }
    };
    if (map.isStyleLoaded()) apply(); else map.once('load', apply);
  }, [route]);

  /* -- actions -- */
  const showArea = async (res: { area: Area; streets: Street[] }) => {
    setArea(res.area); setStreets(res.streets); setRoute(null);
    const map = mapRef.current!;
    const [s, n, w, e] = res.area.bbox;
    map.fitBounds([[w, s], [e, n]], { padding: 40 });
    const runsRes = await api<{ runs: Run[] }>(`/api/runs?areaSlug=${encodeURIComponent(res.area.slug)}`);
    setRuns(runsRes.runs);
    say(`Loaded ${res.streets.length} street segments.`);
  };

  const pollJob = (jobId: string, token: number) => {
    const tick = async () => {
      if (token !== pollToken.current) return; // cancelled: newer search started or unmounted
      try {
        const j = await api<ImportJob>(`/api/area/jobs/${jobId}`);
        setJob(j);
        if (j.status === 'done') {
          setJob(null);
          const res = await api<{ area: Area; streets: Street[] } | { jobId: string }>('/api/area', { query, includePaths });
          if ('jobId' in res) say('Import finished but the area could not be loaded — try searching again.', true);
          else await showArea(res);
          setBusy(false);
          return;
        }
        if (j.status === 'error') {
          say((j.error || 'Import failed.') + ' Click "Find streets" to retry.', true);
          setJob(null); setBusy(false);
          return;
        }
        setTimeout(tick, 2000);
      } catch (err: any) {
        say(err.message, true); setJob(null); setBusy(false);
      }
    };
    tick();
  };

  const findArea = async () => {
    if (busy) return;
    if (!query.trim()) return say('Enter a city or neighborhood first.', true);
    const token = ++pollToken.current;
    setBusy(true); setJob(null); say('Searching…');
    try {
      const res = await api<{ area: Area; streets: Street[] } | { jobId: string }>('/api/area', { query, includePaths });
      if ('jobId' in res) {
        say('Importing streets — this can take a few minutes for a whole city.');
        pollJob(res.jobId, token);
        return; // stays busy until the poller resolves
      }
      await showArea(res);
      setBusy(false);
    } catch (err: any) {
      say(err.message, true);
      setBusy(false);
    }
  };

  const genRoute = async () => {
    if (!area) return;
    const d = parseFloat(dist);
    if (!d || d <= 0) return say('Enter a valid distance.', true);
    const budget = unit === 'km' ? d * 1000 : d * 1609.344;
    setBusy(true); say('Plotting route…');
    try {
      const r = await api<Route>('/api/route', {
        areaSlug: area.slug, budgetMeters: budget, loop,
        start: startMode === 'click' && startPt ? { lat: startPt[0], lon: startPt[1] } : null
      });
      setRoute(r);
      say(`Route ready — ${fmt(r.totalDist, unit)}.`);
    } catch (err: any) { say(err.message, true); }
    finally { setBusy(false); }
  };

  const downloadGpx = () => route && area &&
    apiDownload('/api/gpx', { coords: route.coords, name: `Run ${area.label.split(',')[0]} ${new Date().toISOString().slice(0, 10)}` },
      'route.gpx').catch(e => say(e.message, true));

  const complete = async () => {
    if (!route || !area) return;
    setBusy(true);
    try {
      await api('/api/runs', {
        areaSlug: area.slug, coords: route.coords, edgeIds: route.edgeIds,
        totalDist: route.totalDist, newStreetDist: route.newStreetDist
      });
      // refresh coverage + runs
      const res = await api<{ area: Area; streets: Street[] }>('/api/area', { query: area.slug.replace(/-paths$/, '').replace(/-/g, ' '), includePaths });
      setStreets(res.streets);
      const runsRes = await api<{ runs: Run[] }>(`/api/runs?areaSlug=${encodeURIComponent(area.slug)}`);
      setRuns(runsRes.runs);
      say('Run saved — coverage updated.');
    } catch (err: any) { say(err.message, true); }
    finally { setBusy(false); }
  };

  const coverage = (() => {
    let total = 0, done = 0;
    streets.forEach(s => { total += s.length; if (s.times > 0) done += s.length; });
    return total ? done / total : 0;
  })();
  const lifetime = runs.reduce((s, r) => s + r.distance_m, 0);

  return (
    <div id="app">
      <div id="sidebar">
        <header className="brand">
          <p className="eyebrow">// route survey tool</p>
          <h1>Every Street</h1>
          <p className="who">{email} · <a onClick={() => supabase.auth.signOut()}>sign out</a></p>
        </header>

        <div className="section">
          <h2>01 · Area</h2>
          <input type="text" placeholder="e.g. Alameda, CA" value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && findArea()} />
          <label className="checkline">
            <input type="checkbox" checked={includePaths} onChange={e => setIncludePaths(e.target.checked)} />
            include footpaths &amp; trails
          </label>
          <button className="primary" onClick={findArea} disabled={busy}>Find streets</button>
          {job && <div className="importjob">
            <p className="hint">{job.phase === 'fetching' && job.tilesTotal > 0
              ? `Importing streets — tile ${job.tilesDone} of ${job.tilesTotal}`
              : `Importing streets — ${job.phase}…`}</p>
            <div className="coverbar"><div className="fill" style={{
              width: (job.tilesTotal > 0 ? Math.max(5, (job.tilesDone / job.tilesTotal) * 100) : 5) + '%'
            }} /></div>
          </div>}
        </div>

        {area && <>
          <div className="section">
            <h2>02 · Start point</h2>
            <div className="radiogroup">
              <label className={startMode === 'auto' ? 'on' : ''}>
                <input type="radio" checked={startMode === 'auto'} onChange={() => setStartMode('auto')} />Assign for me
              </label>
              <label className={startMode === 'click' ? 'on' : ''}>
                <input type="radio" checked={startMode === 'click'} onChange={() => setStartMode('click')} />Click on map
              </label>
            </div>
            <p className="hint">{startMode === 'click'
              ? (startPt ? 'Start set — click the map to move it.' : 'Click anywhere on the map to set your start.')
              : "A start near the most uncovered streets will be chosen. Travel to the start doesn't count toward your distance."}</p>
          </div>

          <div className="section">
            <h2>03 · Route</h2>
            <div className="row">
              <input type="number" min="0.25" step="0.25" value={dist} onChange={e => setDist(e.target.value)} />
              <select value={unit} onChange={e => setUnit(e.target.value as 'mi' | 'km')}>
                <option value="mi">miles</option><option value="km">km</option>
              </select>
            </div>
            <label className="checkline">
              <input type="checkbox" checked={loop} onChange={e => setLoop(e.target.checked)} />
              loop back to start
            </label>
            <button className="primary" onClick={genRoute} disabled={busy}>Generate route</button>
            {route && <div className="routebox">
              <div className="statgrid">
                <div className="stat"><div className="n">{fmt(route.totalDist, unit)}</div><div className="l">route distance</div></div>
                <div className="stat"><div className="n">{route.totalDist ? Math.round(100 * route.newStreetDist / route.totalDist) : 0}%</div><div className="l">new streets</div></div>
              </div>
              <button className="accent" onClick={downloadGpx}>Download GPX</button>
              <button className="ghost" onClick={complete} disabled={busy}>Mark run complete</button>
            </div>}
          </div>

          <div className="section">
            <h2>04 · Coverage</h2>
            <div className="statgrid">
              <div className="stat"><div className="n">{Math.round(coverage * 100)}%</div><div className="l">streets run</div></div>
              <div className="stat"><div className="n">{fmt(lifetime, unit)}</div><div className="l">lifetime distance</div></div>
            </div>
            <div className="coverbar"><div className="fill" style={{ width: coverage * 100 + '%' }} /></div>
            <div className="legend">
              <span><i style={{ background: '#5d6a60' }} /> not yet run</span>
              <span><i style={{ background: '#6b8f71' }} /> run once</span>
              <span><i style={{ background: '#e0c34c' }} /> run 2+</span>
              <span><i style={{ background: '#4fb0ff' }} /> current route</span>
            </div>
            {runs.length > 0 && <ul className="runlist">
              {runs.map(r => <li key={r.id}>
                <span>{fmt(r.distance_m, unit)} · {new Date(r.created_at).toLocaleDateString()}</span>
              </li>)}
            </ul>}
          </div>
        </>}
        <p className={'status' + (isErr ? ' err' : '')}>{status}</p>
      </div>
      <div id="mapwrap"><div ref={mapDiv} id="map" /></div>
    </div>
  );
}
