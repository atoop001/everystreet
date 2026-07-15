import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
);

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

async function token(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const t = data.session?.access_token;
  if (!t) throw new Error('Sign in required.');
  return t;
}

export async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const res = await fetch(API + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (await token())
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    let msg = 'Request failed (' + res.status + ')';
    try { msg = (await res.json()).error || msg; } catch { /* keep default */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export async function apiDownload(path: string, body: unknown, filename: string) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await token()) },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('Download failed.');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
