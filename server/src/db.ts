import { createClient, SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;
export function db(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY in server/.env');
    client = createClient(url, key, { auth: { persistSession: false } });
  }
  return client;
}

export interface AreaRow {
  id: string; slug: string; label: string;
  bbox: [number, number, number, number];
  center: [number, number];
  street_count: number; total_length_m: number;
}

export async function getArea(slug: string): Promise<AreaRow | null> {
  const { data, error } = await db().from('areas').select('*').eq('slug', slug).maybeSingle();
  if (error) throw error;
  return data as AreaRow | null;
}

export async function saveArea(area: Omit<AreaRow, 'id'>, streets: {
  edge_id: string; name: string; length_m: number;
  from_node: number; to_node: number; coords: [number, number][];
}[]): Promise<AreaRow> {
  const { data, error } = await db().from('areas').insert(area).select().single();
  if (error) throw error;
  const areaRow = data as AreaRow;
  // Insert streets in chunks to stay under payload limits.
  const rows = streets.map(s => ({ ...s, id: `${area.slug}:${s.edge_id}`, area_id: areaRow.id }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error: e2 } = await db().from('streets').insert(rows.slice(i, i + 500));
    if (e2) throw e2;
  }
  return areaRow;
}

export async function getStreets(areaId: string) {
  const all: any[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await db().from('streets')
      .select('edge_id,name,length_m,from_node,to_node,coords')
      .eq('area_id', areaId).range(from, from + page - 1);
    if (error) throw error;
    all.push(...(data || []));
    if (!data || data.length < page) break;
  }
  return all;
}

export async function getCovered(userId: string, areaSlug: string): Promise<Map<string, number>> {
  const { data, error } = await db().from('covered')
    .select('street_id,times')
    .eq('user_id', userId)
    .like('street_id', `${areaSlug}:%`);
  if (error) throw error;
  const m = new Map<string, number>();
  (data || []).forEach(r => m.set(r.street_id.split(':').slice(1).join(':'), r.times));
  return m;
}

export async function markCovered(userId: string, areaSlug: string, edgeIds: string[]) {
  const existing = await getCovered(userId, areaSlug);
  const rows = [...new Set(edgeIds)].map(eid => ({
    user_id: userId,
    street_id: `${areaSlug}:${eid}`,
    times: (existing.get(eid) || 0) + 1,
    updated_at: new Date().toISOString()
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db().from('covered').upsert(rows.slice(i, i + 500));
    if (error) throw error;
  }
}

export async function saveRun(userId: string, areaId: string, r: {
  distance_m: number; new_distance_m: number; coords: [number, number][];
}) {
  const { data, error } = await db().from('runs').insert({ user_id: userId, area_id: areaId, ...r }).select('id,created_at').single();
  if (error) throw error;
  return data;
}

export async function listRuns(userId: string, areaId: string) {
  const { data, error } = await db().from('runs')
    .select('id,distance_m,new_distance_m,created_at')
    .eq('user_id', userId).eq('area_id', areaId)
    .order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  return data || [];
}

export async function getRun(userId: string, runId: string) {
  const { data, error } = await db().from('runs')
    .select('*').eq('id', runId).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data;
}

export interface JobRow {
  id: string; slug: string; query: string; include_paths: boolean;
  status: 'queued' | 'running' | 'done' | 'error';
  phase: string; tiles_total: number; tiles_done: number;
  error: string | null; area_id: string | null; created_at: string;
}

export async function createJob(slug: string, query: string, includePaths: boolean): Promise<JobRow> {
  const { data, error } = await db().from('import_jobs')
    .insert({ slug, query, include_paths: includePaths }).select().single();
  if (error) {
    // 23505 = unique violation: a concurrent request created the active
    // job for this slug first — share it instead of failing.
    if ((error as { code?: string }).code === '23505') {
      const existing = await getActiveJobBySlug(slug);
      if (existing) return existing;
    }
    throw error;
  }
  return data as JobRow;
}

export async function getJob(id: string): Promise<JobRow | null> {
  const { data, error } = await db().from('import_jobs').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data as JobRow | null;
}

export async function getActiveJobBySlug(slug: string): Promise<JobRow | null> {
  const { data, error } = await db().from('import_jobs').select('*')
    .eq('slug', slug).in('status', ['queued', 'running'])
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data as JobRow | null;
}

export async function claimNextJob(): Promise<JobRow | null> {
  const { data, error } = await db().from('import_jobs').select('*')
    .eq('status', 'queued').order('created_at', { ascending: true })
    .limit(1).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  // Guarded update makes the claim atomic: only the caller that flips
  // queued→running gets the job back; a racing claimant gets null and
  // simply polls again.
  const { data: claimed, error: claimError } = await db().from('import_jobs')
    .update({ status: 'running', phase: 'geocoding', updated_at: new Date().toISOString() })
    .eq('id', data.id).eq('status', 'queued')
    .select().maybeSingle();
  if (claimError) throw claimError;
  return (claimed as JobRow | null) ?? null;
}

export async function updateJob(
  id: string,
  patch: Partial<Pick<JobRow, 'status' | 'phase' | 'tiles_total' | 'tiles_done' | 'error' | 'area_id'>>
): Promise<void> {
  const { error } = await db().from('import_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

export async function failStaleRunningJobs(): Promise<void> {
  // Queued jobs survive a restart (the worker will pick them up); only
  // jobs caught mid-flight are unrecoverable.
  const { error } = await db().from('import_jobs')
    .update({
      status: 'error',
      error: 'The server restarted mid-import — please retry.',
      updated_at: new Date().toISOString()
    })
    .eq('status', 'running');
  if (error) throw error;
}
