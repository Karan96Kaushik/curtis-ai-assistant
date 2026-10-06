import { HttpError, type HttpEvent } from './http.js';
import { readEnv } from './secrets.js';
import { verifySupabaseJwt } from './supabaseJwt.js';

export interface AuthedCaller {
  userId: string;
  email: string | null;
  isAnonymous: boolean;
  token: string;
}

function bearerToken(event: HttpEvent): string | null {
  const header = event.headers?.authorization ?? event.headers?.Authorization;
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export async function requireAuth(event: HttpEvent): Promise<AuthedCaller> {
  const token = bearerToken(event);
  if (!token) throw new HttpError(401, 'Sign in required');
  const claims = await verifySupabaseJwt(token);
  return { userId: claims.sub, email: claims.email, isAnonymous: claims.isAnonymous, token };
}

export async function optionalAuth(event: HttpEvent): Promise<AuthedCaller | null> {
  return bearerToken(event) ? requireAuth(event) : null;
}

/**
 * The agent acts with the deployer's Jira/GitHub credentials, so only emails
 * listed in ALLOWED_EMAILS may use it. An empty list admits nobody.
 */
export async function requireAllowedCaller(event: HttpEvent): Promise<AuthedCaller> {
  const caller = await requireAuth(event);
  const allowed = new Set(
    readEnv('ALLOWED_EMAILS')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
  const email = caller.email?.toLowerCase();
  if (caller.isAnonymous || !email || !allowed.has(email)) {
    throw new HttpError(403, 'This account is not allowed to use Curtis. Ask the owner to add your email to ALLOWED_EMAILS.');
  }
  return caller;
}
