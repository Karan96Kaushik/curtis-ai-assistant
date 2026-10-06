import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseConfig } from './secrets.js';
import type { AuthedCaller } from './verifySupabaseAuth.js';

/** Client bound to the caller's JWT, so every query runs under the same RLS as the browser. */
export function supabaseForCaller(caller: AuthedCaller): SupabaseClient {
  const { url, publishableKey } = supabaseConfig();
  return createClient(url, publishableKey, {
    global: { headers: { Authorization: `Bearer ${caller.token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
