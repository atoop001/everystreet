import type { Request, Response, NextFunction } from 'express';
import * as jose from 'jose';

// Verifies the Supabase access token the web app sends with each request,
// against the project's public JWT signing keys
// (Supabase dashboard → Settings → JWT Keys). No secret needed here —
// keys are fetched and cached from the project's JWKS endpoint.
let jwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null;
let issuer: string | null = null;
function getVerifier() {
  if (!jwks || !issuer) {
    const url = process.env.SUPABASE_URL;
    if (!url) throw new Error('Set SUPABASE_URL in server/.env');
    issuer = `${url.replace(/\/$/, '')}/auth/v1`;
    jwks = jose.createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  }
  return { jwks, issuer };
}

export interface AuthedRequest extends Request {
  userId?: string;
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Sign in required.' });
    const { jwks, issuer } = getVerifier();
    const { payload } = await jose.jwtVerify(token, jwks, { issuer, audience: 'authenticated' });
    if (!payload.sub) return res.status(401).json({ error: 'Invalid session.' });
    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired — sign in again.' });
  }
}
