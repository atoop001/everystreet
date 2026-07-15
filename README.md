# Every Street

Run every street in your town. Search an area, generate distance-limited
routes that prioritize streets you haven't run, export GPX for Garmin and
GPS apps, and watch the coverage heatmap fill in.

## Structure
- `server/` — Node.js (TypeScript) API: street import & cache, route
  engine, GPX export, auth. `npm run dev` to start, `npm test` for the
  route-engine test suite.
- `web/` — React + Vite web app (maplibre map, Supabase sign-in).
- `supabase/schema.sql` — database schema (run once in Supabase SQL editor).
- `SETUP-GUIDE.md` — **start here.** Step-by-step Windows setup.

## Phase status (see architecture doc)
- [x] Phase 1: accounts, area import, route engine, GPX, heatmap (this code)
- [ ] Phase 2: Expo mobile apps (same API)
- [ ] Phase 3: Strava + Garmin sync
- [ ] Phase 4: store launch

## Production notes
Dev uses Nominatim/Overpass (rate-limited, dev-only). Before public
launch, swap `server/src/osm.ts` to Geofabrik extracts + a commercial
geocoder — the function signatures are designed so nothing else changes.
