import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requireEnv, supabaseConfig } from './secrets.js';
import type { AuthedCaller } from './verifySupabaseAuth.js';

/** Client bound to the caller's JWT, so every query runs under the same RLS as the browser. */
export function supabaseForCaller(caller: AuthedCaller): SupabaseClient {
  const { url, publishableKey } = supabaseConfig();
  return createClient(url, publishableKey, {
    global: { headers: { Authorization: `Bearer ${caller.token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/**
 * Service-role client for server-side reads/writes that must bypass RLS
 * (e.g. loading FCM device tokens for the agent push tool).
 * Uses Amplify secret SUPABASE_SECRET_KEY_CURTIS.
 */
export function supabaseAsService(): SupabaseClient {
  const { url } = supabaseConfig();
  return createClient(url, requireEnv('SUPABASE_SECRET_KEY_CURTIS'), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
