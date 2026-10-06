import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import { HttpError } from './http.js';
import { supabaseConfig } from './secrets.js';

export interface SupabaseClaims {
  sub: string;
  email: string | null;
  isAnonymous: boolean;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function claimsFromPayload(payload: JWTPayload): SupabaseClaims {
  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new HttpError(401, 'Invalid session token');
  }
  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : null,
    isAnonymous: payload.is_anonymous === true,
  };
}

/** Legacy HS256 projects don't publish keys, so ask Supabase Auth to validate the token. */
async function verifyWithAuthServer(token: string): Promise<SupabaseClaims> {
  const { url, publishableKey } = supabaseConfig();
  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: publishableKey, authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new HttpError(401, 'Invalid or expired session');
  const user = (await res.json()) as { id?: string; email?: string; is_anonymous?: boolean };
  return claimsFromPayload({ sub: user.id, email: user.email, is_anonymous: user.is_anonymous });
}

/** Verify a Supabase access token: asymmetric keys via JWKS, HS256 via the Auth server. */
export async function verifySupabaseJwt(token: string): Promise<SupabaseClaims> {
  let alg: string | undefined;
  try {
    alg = decodeProtectedHeader(token).alg;
  } catch {
    throw new HttpError(401, 'Malformed session token');
  }

  if (!alg || alg === 'HS256') return verifyWithAuthServer(token);

  const { url } = supabaseConfig();
  const issuer = `${url}/auth/v1`;
  jwks ??= createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: 'authenticated' });
    return claimsFromPayload(payload);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(401, 'Invalid or expired session');
  }
}
