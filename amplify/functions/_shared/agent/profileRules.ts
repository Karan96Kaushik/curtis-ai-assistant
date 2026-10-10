import type { ProfileSnapshot, ProviderName, ToolDef } from './types.js';

export const CORE_TOOL_NAMES = new Set(['ask_user', 'finish', 'update_scratchpad']);

/** Reads of private message content. */
export const PRIVATE_READ_TOOLS = new Set([
  'email.list',
  'email.get',
  'whatsapp.list_chats',
  'whatsapp.get_messages',
]);

/**
 * Outbound writes that can leave the user's accounts.
 * push.send is to the user only, so it is not in this set.
 */
export function outboundToolNames(tools: readonly Pick<ToolDef, 'name' | 'integration' | 'access'>[]): Set<string> {
  const names = new Set<string>(['email.send', 'whatsapp.send']);
  for (const tool of tools) {
    if (tool.integration === 'github' && tool.access === 'write') names.add(tool.name);
  }
  return names;
}

export interface ProfileDraft {
  name: string;
  description: string | null;
  system_prompt: string;
  allowed_tools: string[];
  approval_required: string[];
  model_chain: { provider: string; model: string }[];
  allowed_providers: string[];
  max_steps: number;
  max_runtime_min: number;
  token_budget: number;
  resource_scopes: Record<string, unknown>;
}

const PROVIDERS = new Set<ProviderName>(['groq', 'google', 'openrouter']);

function isProvider(value: string): value is ProviderName {
  return PROVIDERS.has(value as ProviderName);
}

export interface ProfileRules {
  knownTools: Set<string>;
  outbound: Set<string>;
}

/** Returns human-readable errors. An empty list means the profile may be saved. */
export function validateProfile(draft: ProfileDraft, rules: ProfileRules): string[] {
  const errors: string[] = [];
  const name = draft.name.trim();
  if (!name || name.length > 80) errors.push('Name must be 1–80 characters.');
  if (draft.description && draft.description.length > 500) errors.push('Description is too long.');
  const prompt = draft.system_prompt.trim();
  if (!prompt || prompt.length > 4000) errors.push('System prompt must be 1–4000 characters.');

  const allowed = [...new Set(draft.allowed_tools.map((tool) => tool.trim()).filter(Boolean))];
  for (const tool of allowed) {
    if (CORE_TOOL_NAMES.has(tool)) continue;
    if (!rules.knownTools.has(tool)) errors.push(`Unknown tool ${tool}.`);
  }

  const approval = [...new Set(draft.approval_required.map((tool) => tool.trim()).filter(Boolean))];
  for (const tool of approval) {
    if (CORE_TOOL_NAMES.has(tool)) errors.push(`${tool} is a core tool and cannot require approval.`);
    if (!allowed.includes(tool)) errors.push(`${tool} is in approval_required but not allowed_tools.`);
  }

  const readsPrivate = allowed.some((tool) => PRIVATE_READ_TOOLS.has(tool));
  const outbound = allowed.filter((tool) => rules.outbound.has(tool));
  if (readsPrivate && outbound.length) {
    const missing = outbound.filter((tool) => !approval.includes(tool));
    if (missing.length) {
      errors.push(
        `This profile can read private messages and send outbound. Add approval for: ${missing.join(', ')}.`
      );
    }
  }

  const providers = draft.allowed_providers.filter(isProvider);
  if (!providers.length) errors.push('Choose at least one model provider.');
  if (draft.allowed_providers.some((provider) => !isProvider(provider))) {
    errors.push('allowed_providers has an unknown provider.');
  }

  const chain = draft.model_chain.filter(
    (entry) => isProvider(entry.provider) && providers.includes(entry.provider) && entry.model.trim()
  );
  if (!draft.model_chain.length || !chain.length) {
    errors.push('Model chain is empty after applying allowed providers.');
  }

  if (!Number.isInteger(draft.max_steps) || draft.max_steps < 1 || draft.max_steps > 100) {
    errors.push('max_steps must be from 1 to 100.');
  }
  if (!Number.isInteger(draft.max_runtime_min) || draft.max_runtime_min < 1 || draft.max_runtime_min > 1440) {
    errors.push('max_runtime_min must be from 1 to 1440.');
  }
  if (!Number.isInteger(draft.token_budget) || draft.token_budget < 1000 || draft.token_budget > 500000) {
    errors.push('token_budget must be from 1000 to 500000.');
  }

  return errors;
}

/** Groq first, then Google. OpenRouter is omitted for profiles that read personal mail. */
export function defaultModelChain(): ProfileSnapshot['model_chain'] {
  const groq = process.env.GROQ_MODEL?.trim() || 'openai/gpt-oss-120b';
  const groqFallback = process.env.GROQ_FALLBACK_MODEL?.trim() || 'openai/gpt-oss-20b';
  return [
    { provider: 'groq', model: groq },
    { provider: 'groq', model: groqFallback },
    { provider: 'google', model: 'gemini-3.5-flash-lite' },
  ];
}

export function inboxProfileDraft(): ProfileDraft {
  return {
    name: 'Inbox',
    description: 'Reads recent email notifications from your phone. Does not send mail.',
    system_prompt:
      'You triage the user\'s recent email. Read the mailbox, summarize what needs attention, and finish with a short summary. Ask when a choice is ambiguous.',
    allowed_tools: ['email.list', 'email.get'],
    approval_required: [],
    model_chain: defaultModelChain(),
    allowed_providers: ['groq', 'google'],
    max_steps: 25,
    max_runtime_min: 60,
    token_budget: 60000,
    resource_scopes: {},
  };
}

export function snapshotFrom(profile: ProfileSnapshot): ProfileSnapshot {
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    system_prompt: profile.system_prompt,
    allowed_tools: [...profile.allowed_tools],
    approval_required: [...profile.approval_required],
    model_chain: profile.model_chain.map((entry) => ({ ...entry })),
    allowed_providers: [...profile.allowed_providers],
    max_steps: profile.max_steps,
    max_runtime_min: profile.max_runtime_min,
    token_budget: profile.token_budget,
    resource_scopes: { ...profile.resource_scopes },
  };
}
