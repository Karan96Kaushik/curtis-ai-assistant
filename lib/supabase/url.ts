/** Project origin without a trailing slash or a pasted `/rest/v1` suffix. */
export function normalizeSupabaseUrl(raw: string | null | undefined): string {
  return String(raw ?? '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1$/i, '');
}

/** `abcd1234` from `https://abcd1234.supabase.co`; null for custom domains it can't infer. */
export function projectRefFromUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    const [ref] = host.split('.');
    return ref || null;
  } catch {
    return null;
  }
}
