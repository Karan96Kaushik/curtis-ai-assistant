import outputs from '@/amplify_outputs.json';
import { supabase } from '@/utils/supabase';

export type FunctionKey = 'chat';

const FUNCTION_KEYS: FunctionKey[] = ['chat'];

const custom = ((outputs as { custom?: Record<string, unknown> }).custom ?? {}) as Record<string, unknown>;

function functionUrl(key: FunctionKey): string | null {
  const value = custom[`${key}Url`];
  return typeof value === 'string' && value ? value : null;
}

export const functionsConfigured = FUNCTION_KEYS.every((key) => functionUrl(key) !== null);

export class FunctionConfigError extends Error {
  constructor(key: FunctionKey) {
    super(
      `No URL for the "${key}" function in amplify_outputs.json. Run \`npm run amplify:sandbox\` to deploy the backend and regenerate it.`
    );
    this.name = 'FunctionConfigError';
  }
}

export class FunctionCallError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'FunctionCallError';
    this.status = status;
  }
}

export async function callFunction<TResponse>(
  key: FunctionKey,
  body: unknown,
  { auth = 'required', signal }: { auth?: 'required' | 'optional'; signal?: AbortSignal } = {}
): Promise<TResponse> {
  const url = functionUrl(key);
  if (!url) throw new FunctionConfigError(key);

  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token && auth === 'required') {
    throw new FunctionCallError(401, 'Your session has expired. Sign in again.');
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });

  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const message =
      (payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : null) ?? `Request failed (${res.status})`;
    throw new FunctionCallError(res.status, message);
  }
  return payload as TResponse;
}
