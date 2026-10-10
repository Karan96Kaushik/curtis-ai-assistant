import { defineFunction, secret } from '@aws-amplify/backend';

/**
 * Polls for due jobs. The rate has to be longer than this timeout, so the
 * agent work itself lives in runScheduledJob (15 min) and this function only
 * claims rows and invokes it.
 */
export const scheduleTick = defineFunction({
  name: 'scheduleTick',
  entry: './handler.ts',
  runtime: 22,
  timeoutSeconds: 45,
  memoryMB: 256,
  schedule: 'every 1m',
  environment: {
    SUPABASE_URL: process.env.VITE_SUPABASE_URL_CURTIS ?? '',
    SUPABASE_PUBLISHABLE_KEY: process.env.VITE_SUPABASE_PUBLISHABLE_KEY_CURTIS ?? '',
    SUPABASE_SECRET_KEY_CURTIS: secret('SUPABASE_SECRET_KEY_CURTIS'),
  },
});
