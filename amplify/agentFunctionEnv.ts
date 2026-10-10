import { secret } from '@aws-amplify/backend';

const STATE_DIR = '/tmp/curtis';

/** Optional non-secret settings, copied only when set so the core keeps its defaults. */
const PASSTHROUGH_ENV = [
  'JIRA_BASE_URL',
  'JIRA_EMAIL',
  'SERP_PROVIDER',
  'GROQ_MODEL',
  'GROQ_FALLBACK_MODEL',
  'REQUIRE_CONFIRMATION',
  'GITHUB_ACTIVITY_LOGINS',
  'GITHUB_ACTIVITY_ALIASES',
  'GITHUB_ACTIVITY_EXCLUDE_OWNERS',
  'GITHUB_ACTIVITY_ALL_BRANCHES',
] as const;

function passthroughEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PASSTHROUGH_ENV) {
    const value = process.env[name];
    if (value) out[name] = value;
  }
  return out;
}

/** Env shared by every Lambda that runs the Curtis agent. */
export function agentFunctionEnvironment() {
  return {
    ...passthroughEnv(),
    SUPABASE_URL: process.env.VITE_SUPABASE_URL_CURTIS ?? '',
    SUPABASE_PUBLISHABLE_KEY: process.env.VITE_SUPABASE_PUBLISHABLE_KEY_CURTIS ?? '',
    ALLOWED_EMAILS: process.env.ALLOWED_EMAILS ?? '',
    CURTIS_SURFACE: 'web',
    CURTIS_STATE_DIR: STATE_DIR,
    ORG_MEMORY_PATH: `${STATE_DIR}/org-memory.md`,
    BEHAVIOR_MEMORY_PATH: `${STATE_DIR}/behavior.md`,
    WF_RELEASE_DIR: `${STATE_DIR}/releases`,
    GROQ_API_KEY: secret('GROQ_API_KEY'),
    GOOGLE_AI_STUDIO_API_KEY: secret('GOOGLE_AI_STUDIO_API_KEY'),
    OPENROUTER_API_KEY: secret('OPENROUTER_API_KEY'),
    JIRA_API_TOKEN: secret('JIRA_API_TOKEN'),
    GITHUB_TOKEN: secret('GITHUB_TOKEN'),
    SERP_API_KEY: secret('SERP_API_KEY'),
    FIREBASE_SDK_SA_KEY: secret('FIREBASE_SDK_SA_KEY'),
    SUPABASE_SECRET_KEY_CURTIS: secret('SUPABASE_SECRET_KEY_CURTIS'),
  };
}
