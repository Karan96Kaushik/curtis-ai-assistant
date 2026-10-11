import { chainFromModelIds } from '../../../../lib/agents/modelChain.js';
import { coreRulesForTools } from './context.js';
import type { AgentRuntime } from './deps.js';
import { redactSensitive } from './notificationStore.js';
import { defaultModelChain } from './profileRules.js';
import { AgentInputError } from './runs.js';
import { preview, redactValue } from './text.js';
import type { AgentEvent, ProfileSnapshot, ProviderName, RunRecord, RunStatus } from './types.js';

export const ANALYZE_EVENT_CAP = 80;
export const SUGGESTED_PROMPT_MAX = 4000;

const TERMINAL: ReadonlySet<RunStatus> = new Set(['done', 'failed', 'cancelled']);

const EVENT_KEYS = [
  'name',
  'tool',
  'question',
  'text',
  'preview',
  'error',
  'from',
  'to',
  'status',
  'detail',
  'decision',
  'reason',
  'options',
  'args',
] as const;

export interface AnalysisEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
}

export interface AnalysisPack {
  command: string;
  status: string;
  error: string | null;
  result_summary: string | null;
  scratchpad: string;
  step_count: number;
  tokens_used: number;
  live_system_prompt: string;
  run_system_prompt: string;
  events: AnalysisEvent[];
}

export interface ProfileSuggestion {
  rationale: string;
  suggested_system_prompt: string;
  change_bullets: string[];
}

export function stripUntrustedBlocks(text: string): string {
  return text.replace(/<untrusted_data\b[^>]*>[\s\S]*?<\/untrusted_data>/gi, (block) => {
    const inner = block.replace(/<\/?untrusted_data\b[^>]*>/gi, '').replace(/\s+/g, ' ').trim();
    return `[untrusted preview: ${inner.slice(0, 120)}]`;
  });
}

export function redactAnalysisText(text: string, max = 200): string {
  return preview(redactSensitive(stripUntrustedBlocks(text)), max);
}

function compactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactAnalysisText(value, 200);
  if (Array.isArray(value)) return value.slice(0, 6).map(compactValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 8)
        .map(([key, item]) => [key, compactValue(item)])
    );
  }
  return value;
}

export function compactEventPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactValue(payload);
  const row = redacted && typeof redacted === 'object' && !Array.isArray(redacted) ? (redacted as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const key of EVENT_KEYS) {
    if (row[key] === undefined) continue;
    out[key] = compactValue(row[key]);
  }
  return out;
}

export function buildAnalysisPack(
  run: RunRecord,
  events: AgentEvent[],
  livePrompt: string
): AnalysisPack {
  return {
    command: redactAnalysisText(run.command, 400),
    status: run.status,
    error: run.error ? redactAnalysisText(run.error, 300) : null,
    result_summary: run.result_summary ? redactAnalysisText(run.result_summary, 400) : null,
    scratchpad: run.scratchpad ? redactAnalysisText(run.scratchpad, 200) : '',
    step_count: run.step_count,
    tokens_used: run.tokens_used,
    live_system_prompt: livePrompt.trim().slice(0, SUGGESTED_PROMPT_MAX),
    run_system_prompt: run.profile_snapshot.system_prompt.trim().slice(0, SUGGESTED_PROMPT_MAX),
    events: events.slice(0, ANALYZE_EVENT_CAP).map((event) => ({
      seq: event.seq,
      type: event.type,
      payload: compactEventPayload(event.payload),
    })),
  };
}

export function parseAnalysisSuggestion(text: string): ProfileSuggestion {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new AgentInputError('The model did not return a suggestion.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new AgentInputError('The model did not return a suggestion.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AgentInputError('The model did not return a suggestion.');
  }
  const row = parsed as Record<string, unknown>;
  const rationale = typeof row.rationale === 'string' ? row.rationale.trim() : '';
  const suggested = typeof row.suggested_system_prompt === 'string' ? row.suggested_system_prompt.trim() : '';
  if (!rationale) throw new AgentInputError('The suggestion is missing a rationale.');
  if (!suggested || suggested.length > SUGGESTED_PROMPT_MAX) {
    throw new AgentInputError(`Suggested instructions must be 1–${SUGGESTED_PROMPT_MAX} characters.`);
  }
  const bullets = Array.isArray(row.change_bullets)
    ? row.change_bullets
        .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
        .map((item) => item.trim().slice(0, 200))
        .slice(0, 8)
    : [];
  return {
    rationale: rationale.slice(0, 2000),
    suggested_system_prompt: suggested,
    change_bullets: bullets,
  };
}

function analysisSystemPrompt(allowedTools: readonly string[]): string {
  return [
    'You improve an agent profile\'s Instructions (system_prompt) from ONE finished run.',
    'Return JSON only with keys rationale, suggested_system_prompt, and change_bullets.',
    `suggested_system_prompt must be 1–${SUGGESTED_PROMPT_MAX} characters.`,
    'Do not contradict these core rules:',
    coreRulesForTools(allowedTools),
    'Improve future behaviour for similar goals using only this run.',
    'Keep useful existing instructions. Do not invent tools, permissions, or facts that are not in the pack.',
    'Do not include notification bodies, secrets, or untrusted_data in the suggestion.',
  ].join(' ');
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Hard cap: keep at most maxWords, preserving early wording. */
export function clampToMaxWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text.trim();
  return words.slice(0, Math.max(1, maxWords)).join(' ');
}

function improveSystemPrompt(maxWords: number, allowedTools: readonly string[]): string {
  return [
    'Rewrite the agent Instructions to be clearer and more actionable.',
    'Return the improved Instructions only — no JSON, no markdown fences, no commentary.',
    `At most ${maxWords} words (at most double the original). Prefer fewer words when possible.`,
    'Keep the intent. Do not invent tools, permissions, or facts.',
    'Do not contradict these core rules:',
    coreRulesForTools(allowedTools),
  ].join(' ');
}

function profileForImprove(
  live: ProfileSnapshot | null,
  modelIds: string[] | undefined
): ProfileSnapshot {
  if (live) return live;
  const { chain } = chainFromModelIds(modelIds ?? []);
  const model_chain = chain.length ? chain : defaultModelChain();
  const allowed_providers = [...new Set(model_chain.map((entry) => entry.provider))] as ProviderName[];
  return {
    id: 'improve',
    name: 'Improve',
    description: null,
    system_prompt: 'Improve instructions.',
    allowed_tools: [],
    approval_required: [],
    allowed_apps: [],
    model_chain,
    allowed_providers,
    max_steps: 5,
    max_runtime_min: 5,
    token_budget: 8000,
    resource_scopes: {},
  };
}

/**
 * LLM rewrite of Instructions. Result is clamped to at most 2× the source word count
 * and 4000 characters. Does not write the profile.
 */
export async function improvePrompt(
  rt: AgentRuntime,
  userId: string,
  input: { system_prompt?: string; profile_id?: string; model_ids?: string[] }
): Promise<{ system_prompt: string; word_count: number; max_words: number }> {
  const source = (input.system_prompt ?? '').trim();
  if (!source || source.length > SUGGESTED_PROMPT_MAX) {
    throw new AgentInputError(`Instructions must be 1–${SUGGESTED_PROMPT_MAX} characters.`);
  }
  const sourceWords = countWords(source);
  const maxWords = Math.max(1, sourceWords * 2);

  let live: ProfileSnapshot | null = null;
  const profileId = input.profile_id?.trim();
  if (profileId) {
    live = await rt.store.loadProfile(profileId, userId);
    if (!live) throw new AgentInputError('Profile not found', 404);
  }

  const improveProfile = profileForImprove(live, input.model_ids);
  const out = await rt.callModel(
    improveProfile,
    [
      { role: 'system', content: improveSystemPrompt(maxWords, improveProfile.allowed_tools) },
      { role: 'user', content: source },
    ],
    []
  );
  if (out.kind === 'rate_limited') {
    throw new AgentInputError('The model is rate limited. Try again shortly.', 429);
  }
  if (out.kind !== 'ok') {
    throw new AgentInputError(out.message || 'The model could not improve these instructions.', 502);
  }

  let improved = out.text.trim();
  improved = improved.replace(/^```(?:\w+)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (!improved) throw new AgentInputError('The model returned empty instructions.');
  improved = clampToMaxWords(improved, maxWords).slice(0, SUGGESTED_PROMPT_MAX);
  if (!improved) throw new AgentInputError('The model returned empty instructions.');
  return { system_prompt: improved, word_count: countWords(improved), max_words: maxWords };
}

export async function analyzeProfileRun(
  rt: AgentRuntime,
  userId: string,
  runId: string
): Promise<ProfileSuggestion> {
  const run = await rt.store.loadRun(runId);
  if (!run || run.user_id !== userId) throw new AgentInputError('Run not found', 404);
  if (!TERMINAL.has(run.status)) {
    throw new AgentInputError('Analyze a finished run (done, failed, or cancelled).', 409);
  }

  const live = await rt.store.loadProfile(run.profile_id, userId);
  const livePrompt = live?.system_prompt ?? run.profile_snapshot.system_prompt;
  const events = await rt.store.listEvents(run.id, ANALYZE_EVENT_CAP);
  const pack = buildAnalysisPack(run, events, livePrompt);
  const profile: ProfileSnapshot = live ?? run.profile_snapshot;

  const out = await rt.callModel(
    profile,
    [
      { role: 'system', content: analysisSystemPrompt(profile.allowed_tools) },
      { role: 'user', content: JSON.stringify(pack) },
    ],
    []
  );
  if (out.kind === 'rate_limited') {
    throw new AgentInputError('The model is rate limited. Try again shortly.', 429);
  }
  if (out.kind !== 'ok') {
    throw new AgentInputError(out.message || 'The model could not analyze this run.', 502);
  }
  return parseAnalysisSuggestion(out.text);
}
