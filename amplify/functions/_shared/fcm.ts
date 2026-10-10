import { SignJWT, importPKCS8 } from 'jose';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from './http.js';
import { requireEnv } from './secrets.js';
import { supabaseAsService } from './supabaseUser.js';

interface ServiceAccount {
  project_id: string;
  private_key: string;
  client_email: string;
}

export interface PushPayload {
  title: string;
  body: string;
  /** FCM data map; every value must be a string. */
  data?: Record<string, string>;
}

export interface PushSendResult {
  sent: number;
  failed: number;
  removed: number;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
  projectId: string;
}

let cached: CachedToken | null = null;

function parseServiceAccount(): ServiceAccount {
  const raw = requireEnv('FIREBASE_SDK_SA_KEY');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(500, 'Server is not configured (FIREBASE_SDK_SA_KEY is not valid JSON)');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(500, 'Server is not configured (FIREBASE_SDK_SA_KEY has the wrong shape)');
  }
  const body = parsed as Record<string, unknown>;
  const projectId = typeof body.project_id === 'string' ? body.project_id : '';
  const clientEmail = typeof body.client_email === 'string' ? body.client_email : '';
  let privateKey = typeof body.private_key === 'string' ? body.private_key : '';
  privateKey = privateKey.replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey.includes('BEGIN')) {
    throw new HttpError(500, 'Server is not configured (FIREBASE_SDK_SA_KEY is incomplete)');
  }
  return { project_id: projectId, private_key: privateKey, client_email: clientEmail };
}

async function getAccessToken(): Promise<{ accessToken: string; projectId: string }> {
  const now = Date.now();
  if (cached && cached.expiresAtMs > now + 60_000) {
    return { accessToken: cached.accessToken, projectId: cached.projectId };
  }

  const sa = parseServiceAccount();
  const key = await importPKCS8(sa.private_key, 'RS256');
  const issuedAt = Math.floor(now / 1000);
  const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/firebase.messaging' })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(sa.client_email)
    .setSubject(sa.client_email)
    .setAudience('https://oauth2.googleapis.com/token')
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 3600)
    .sign(key);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const payload = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
  if (!res.ok || !payload?.access_token) {
    console.error('[fcm] oauth token exchange failed', res.status);
    throw new HttpError(502, 'Could not authenticate with Firebase');
  }

  const expiresInSec = typeof payload.expires_in === 'number' ? payload.expires_in : 3600;
  cached = {
    accessToken: payload.access_token,
    expiresAtMs: now + expiresInSec * 1000,
    projectId: sa.project_id,
  };
  return { accessToken: cached.accessToken, projectId: cached.projectId };
}

function isStaleTokenError(status: number, errorJson: unknown): boolean {
  if (status !== 400 && status !== 404) return false;
  const text = JSON.stringify(errorJson ?? '');
  return /UNREGISTERED|INVALID_ARGUMENT|NOT_FOUND|Requested entity was not found/i.test(text);
}

async function sendOne(
  accessToken: string,
  projectId: string,
  token: string,
  payload: PushPayload
): Promise<'ok' | 'stale' | 'error'> {
  const data =
    payload.data &&
    Object.fromEntries(Object.entries(payload.data).map(([k, v]) => [k, String(v)]));

  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        token,
        notification: { title: payload.title, body: payload.body },
        ...(data && Object.keys(data).length ? { data } : {}),
        android: { priority: 'HIGH' },
      },
    }),
  });

  if (res.ok) return 'ok';
  const errBody = await res.json().catch(() => null);
  if (isStaleTokenError(res.status, errBody)) return 'stale';
  console.error('[fcm] send failed', res.status, errBody);
  return 'error';
}

/**
 * Send a notification to every FCM token for `userId`.
 * Uses the service-role client (SUPABASE_SECRET_KEY_CURTIS) so RLS does not block the agent.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<PushSendResult> {
  if (!userId || typeof userId !== 'string') {
    throw new HttpError(400, 'userId is required');
  }
  return sendPushWithClient(supabaseAsService(), userId, payload);
}

/** @deprecated Prefer sendPushToUser; kept for JWT-scoped callers. */
export async function sendPushToCaller(
  db: SupabaseClient,
  userId: string,
  payload: PushPayload
): Promise<PushSendResult> {
  return sendPushWithClient(db, userId, payload);
}

async function sendPushWithClient(
  db: SupabaseClient,
  userId: string,
  payload: PushPayload
): Promise<PushSendResult> {
  const title = payload.title.trim();
  const body = payload.body.trim();
  if (!title || !body) throw new HttpError(400, 'title and body are required');
  if (title.length > 120) throw new HttpError(400, 'title is too long');
  if (body.length > 1000) throw new HttpError(400, 'body is too long');

  const { data: rows, error } = await db.from('device_tokens').select('token').eq('user_id', userId);
  if (error) {
    console.error('[fcm] device_tokens select failed', error.message);
    throw new HttpError(500, 'Could not load device tokens');
  }

  const tokens = (rows ?? [])
    .map((row) => (typeof row.token === 'string' ? row.token : ''))
    .filter(Boolean);
  if (!tokens.length) {
    return { sent: 0, failed: 0, removed: 0 };
  }

  const { accessToken, projectId } = await getAccessToken();
  let sent = 0;
  let failed = 0;
  let removed = 0;

  for (const token of tokens) {
    const outcome = await sendOne(accessToken, projectId, token, { title, body, data: payload.data });
    if (outcome === 'ok') {
      sent += 1;
      continue;
    }
    if (outcome === 'stale') {
      const { error: delError } = await db.from('device_tokens').delete().eq('user_id', userId).eq('token', token);
      if (!delError) removed += 1;
      else failed += 1;
      continue;
    }
    failed += 1;
  }

  return { sent, failed, removed };
}
