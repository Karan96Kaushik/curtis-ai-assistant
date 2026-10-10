import { defineFunction, secret } from '@aws-amplify/backend';

export const sendPush = defineFunction({
  name: 'sendPush',
  entry: './handler.ts',
  runtime: 22,
  timeoutSeconds: 30,
  memoryMB: 256,
  environment: {
    SUPABASE_URL: process.env.VITE_SUPABASE_URL_CURTIS ?? '',
    SUPABASE_PUBLISHABLE_KEY: process.env.VITE_SUPABASE_PUBLISHABLE_KEY_CURTIS ?? '',
    ALLOWED_EMAILS: process.env.ALLOWED_EMAILS ?? '',
    FIREBASE_SDK_SA_KEY: secret('FIREBASE_SDK_SA_KEY'),
    SUPABASE_SECRET_KEY_CURTIS: secret('SUPABASE_SECRET_KEY_CURTIS'),
  },
});

