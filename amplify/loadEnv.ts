import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { normalizeSupabaseUrl } from '../lib/supabase/url.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// dotenv never overwrites, so the first file loaded wins: .env.local over .env.
config({ path: path.join(root, '.env.local') });
config({ path: path.join(root, '.env') });

if (process.env.VITE_SUPABASE_URL_CURTIS) {
  process.env.VITE_SUPABASE_URL_CURTIS = normalizeSupabaseUrl(process.env.VITE_SUPABASE_URL_CURTIS);
}
