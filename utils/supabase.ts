import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/types';
import { normalizeSupabaseUrl, projectRefFromUrl } from '@/lib/supabase/url';

export interface AuthCallback {
  /** Landed from a password-recovery email. */
  recovery: boolean;
  /** `error_description` from a failed email link. */
  error: string | null;
  /** PKCE-style email link that must be exchanged with verifyOtp. */
  tokenHash: string | null;
  otpType: string | null;
}

/** Read before createClient: the client strips these params from the URL as it consumes them. */
function readAuthCallback(): AuthCallback {
  if (typeof window === 'undefined') {
    return { recovery: false, error: null, tokenHash: null, otpType: null };
  }
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const query = new URLSearchParams(window.location.search);
  const type = hash.get('type') ?? query.get('type');
  return {
    recovery: type === 'recovery',
    error: hash.get('error_description') ?? query.get('error_description'),
    tokenHash: query.get('token_hash'),
    otpType: type,
  };
}

export const authCallback = readAuthCallback();

const url = normalizeSupabaseUrl(import.meta.env.VITE_SUPABASE_URL_CURTIS);
const publishableKey = String(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY_CURTIS ?? '').trim();

export const supabaseConfigured = Boolean(url && publishableKey);

if (!supabaseConfigured) {
  console.warn(
    'Supabase is not configured: set VITE_SUPABASE_URL_CURTIS and VITE_SUPABASE_PUBLISHABLE_KEY_CURTIS in .env.local'
  );
}

const ref = (url && projectRefFromUrl(url)) || 'unconfigured';

export const supabase = createClient<Database>(
  url || 'https://unconfigured.supabase.co',
  publishableKey || 'unconfigured',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: `curtis-auth-${ref}`,
    },
  }
);
