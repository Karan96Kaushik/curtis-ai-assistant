import { HttpError } from './http.js';

/** Value baked in by resource.ts (plain env or a resolved Amplify secret). */
export function readEnv(name: string, fallback = ''): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

export function requireEnv(name: string): string {
  const value = readEnv(name);
  if (!value) {
    console.error(`[secrets] ${name} is not set`);
    throw new HttpError(500, `Server is not configured (${name} missing)`);
  }
  return value;
}

export function supabaseConfig(): { url: string; publishableKey: string } {
  return {
    url: requireEnv('SUPABASE_URL').replace(/\/+$/, ''),
    publishableKey: requireEnv('SUPABASE_PUBLISHABLE_KEY'),
  };
}
