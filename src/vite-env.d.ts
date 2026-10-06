/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL_CURTIS?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY_CURTIS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
