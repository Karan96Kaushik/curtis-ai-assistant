import { chainFromModelIds, providersInChain } from '../../../../lib/agents/modelChain.js';
import type { AgentRuntime } from './deps.js';
import { executeTool } from './execute.js';
import { inboxProfileDraft, outboundToolNames, snapshotFrom, validateProfile, type ProfileDraft } from './profileRules.js';
import { knownToolNames, registryToolName, TOOLS } from './registry.js';
import { redactValue, sanitizeToolError } from './text.js';
import type { EventType, ProfileRecord, RunRecord, RunTrigger } from './types.js';

export class AgentInputError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AgentInputError';
    this.status = status;
  }
}

async function record(rt: AgentRuntime, runId: string, type: EventType, payload: Record<string, unknown>) {
  const seq = await rt.store.nextEventSeq(runId);
  const redacted = redactValue(payload);
  const body = redacted && typeof redacted === 'object' && !Array.isArray(redacted) ? (redacted as Record<string, unknown>) : {};
  await rt.store.insertEvent({ run_id: runId, seq, type, payload: body });
}

async function ownedRun(rt: AgentRuntime, userId: string, runId: string): Promise<RunRecord> {
  const run = await rt.store.loadRun(runId);
  if (!run || run.user_id !== userId) throw new AgentInputError('Run not found', 404);
  return run;
}

export async function ensureInboxProfile(rt: AgentRuntime, userId: string): Promise<ProfileRecord> {
  const existing = await rt.store.findInbox(userId);
  if (existing) return existing;
  const draft = inboxProfileDraft();
  const errors = validateProfile(draft, { knownTools: knownToolNames(TOOLS), outbound: outboundToolNames(TOOLS) });
  if (errors.length) throw new AgentInputError(errors.join(' '));
  const now = rt.now().toISOString();
  const profile: ProfileRecord = {
    id: crypto.randomUUID(),
    user_id: userId,
    name: draft.name,
    description: draft.description,
    system_prompt: draft.system_prompt,
    allowed_tools: draft.allowed_tools,
    approval_required: draft.approval_required,
    model_chain: draft.model_chain.flatMap((entry) => {
      if (entry.provider !== 'groq' && entry.provider !== 'google' && entry.provider !== 'openrouter') return [];
      return [{ provider: entry.provider, model: entry.model }];
    }),
    allowed_providers: draft.allowed_providers.flatMap((provider) =>
      provider === 'groq' || provider === 'google' || provider === 'openrouter' ? [provider] : []
    ),
    max_steps: draft.max_steps,
    max_runtime_min: draft.max_runtime_min,
    token_budget: draft.token_budget,
    resource_scopes: draft.resource_scopes,
    is_system: true,
    created_at: now,
    updated_at: now,
  };
  await rt.store.insertProfile(profile);
  return profile;
}

export async function createRun(
  rt: AgentRuntime,
  userId: string,
  command: string,
  profileId?: string,
  trigger: RunTrigger = 'manual'
): Promise<RunRecord> {
  const text = command.trim();
  if (!text || text.length > 4000) throw new AgentInputError('Command must be 1–4000 characters.');
  const profile = profileId ? await rt.store.loadProfile(profileId, userId) : await ensureInboxProfile(rt, userId);
  if (!profile) throw new AgentInputError('Profile not found', 404);
  const now = rt.now().toISOString();
  const run: RunRecord = {
    id: crypto.randomUUID(),
    user_id: userId,
    profile_id: profile.id,
    profile_snapshot: snapshotFrom(profile),
    command: text,
    trigger,
    status: 'queued',
    messages: [{ role: 'user', content: text }],
    summary: '',
    scratchpad: '',
    summary_until: 0,
    pending_request: null,
    result_summary: null,
    error: null,
    step_count: 0,
    tokens_used: 0,
    no_tool_streak: 0,
    consecutive_errors: 0,
    next_attempt_at: null,
    started_at: null,
    finished_at: null,
    created_at: now,
    updated_at: now,
  };
  await rt.store.insertRun(run);
  await rt.enqueue({ run_id: run.id, expected_step: 0, dedupNonce: 'start' });
  return run;
}

export async function answerRun(rt: AgentRuntime, userId: string, runId: string, text: string): Promise<RunRecord> {
  const run = await ownedRun(rt, userId, runId);
  if (run.status !== 'waiting_input' || run.pending_request?.kind !== 'question') {
    throw new AgentInputError('This run is not waiting for an answer', 409);
  }
  const answer = text.trim();
  if (!answer || answer.length > 4000) throw new AgentInputError('Answer must be 1–4000 characters.');
  const messages = [...run.messages, { role: 'tool' as const, tool_call_id: run.pending_request.tool_call_id, content: answer }];
  const moved = await rt.store.transition(run.id, ['waiting_input'], 'running', { messages, pending_request: null });
  if (!moved) throw new AgentInputError('This run is not waiting for an answer', 409);
  await record(rt, run.id, 'answer', { text: answer.slice(0, 500) });
  await rt.enqueue({ run_id: run.id, expected_step: run.step_count, dedupNonce: `resume:${rt.now().getTime()}` });
  return moved;
}

export async function decideApproval(
  rt: AgentRuntime,
  userId: string,
  runId: string,
  decision: 'approve' | 'deny',
  editedArgs?: unknown,
  note?: string
): Promise<RunRecord> {
  const run = await ownedRun(rt, userId, runId);
  if (run.status !== 'waiting_approval' || run.pending_request?.kind !== 'approval') {
    throw new AgentInputError('This run is not waiting for approval', 409);
  }
  const pending = run.pending_request;
  const def = rt.tools.find((tool) => tool.name === registryToolName(pending.tool));
  if (!def) throw new AgentInputError('That tool is no longer available', 409);

  let content: string;
  if (decision === 'deny') {
    const reason = note?.trim();
    content = reason ? `User denied this action. ${reason.slice(0, 500)}` : 'User denied this action.';
  } else {
    const candidate = editedArgs === undefined ? pending.args : editedArgs;
    const parsed = def.schema.safeParse(candidate);
    if (!parsed.success) {
      const message = parsed.error.issues.map((issue) => issue.message).join('; ');
      throw new AgentInputError(`Invalid arguments: ${message.slice(0, 300)}`);
    }
    const moved = await rt.store.transition(run.id, ['waiting_approval'], 'running', { pending_request: null });
    if (!moved) throw new AgentInputError('This run is not waiting for approval', 409);
    let text: string;
    try {
      text = await executeTool(rt, moved, pending.tool_call_id, def, parsed.data as Record<string, unknown>);
    } catch (err) {
      text = sanitizeToolError(err);
    }
    moved.messages = [...moved.messages, { role: 'tool', tool_call_id: pending.tool_call_id, content: text }];
    const saved = await rt.store.save(moved);
    if (!saved) throw new AgentInputError('This run changed before the action could be saved', 409);
    await record(rt, run.id, 'approval', { decision: 'approve', tool: def.name });
    await rt.enqueue({ run_id: run.id, expected_step: run.step_count, dedupNonce: `resume:${rt.now().getTime()}` });
    return moved;
  }

  const messages = [...run.messages, { role: 'tool' as const, tool_call_id: pending.tool_call_id, content }];
  const moved = await rt.store.transition(run.id, ['waiting_approval'], 'running', { messages, pending_request: null });
  if (!moved) throw new AgentInputError('This run is not waiting for approval', 409);
  await record(rt, run.id, 'approval', { decision: 'deny', tool: def.name });
  await rt.enqueue({ run_id: run.id, expected_step: run.step_count, dedupNonce: `resume:${rt.now().getTime()}` });
  return moved;
}

export async function cancelRun(rt: AgentRuntime, userId: string, runId: string): Promise<RunRecord> {
  const run = await ownedRun(rt, userId, runId);
  if (run.status === 'done' || run.status === 'failed' || run.status === 'cancelled') {
    throw new AgentInputError('This run has already finished', 409);
  }
  const moved = await rt.store.transition(
    run.id,
    ['queued', 'running', 'waiting_input', 'waiting_approval'],
    'cancelled',
    { pending_request: null, finished_at: rt.now().toISOString() }
  );
  if (!moved) throw new AgentInputError('This run has already finished', 409);
  await record(rt, run.id, 'cancelled', {});
  return moved;
}

export interface SaveProfileInput {
  id?: string;
  name?: string;
  description?: string | null;
  system_prompt?: string;
  allowed_tools?: unknown;
  approval_required?: unknown;
  model_ids?: unknown;
  max_steps?: unknown;
  max_runtime_min?: unknown;
  token_budget?: unknown;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function wholeNumber(value: unknown, fallback: number): number {
  if (value == null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

function profileRules() {
  return { knownTools: knownToolNames(TOOLS), outbound: outboundToolNames(TOOLS) };
}

function draftFromInput(input: SaveProfileInput): ProfileDraft {
  const { chain, unknown } = chainFromModelIds(stringList(input.model_ids));
  if (unknown.length) throw new AgentInputError(`Unknown model: ${unknown.join(', ')}`);
  if (!chain.length) throw new AgentInputError('Choose at least one model.');
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  return {
    name: typeof input.name === 'string' ? input.name : '',
    description: description || null,
    system_prompt: typeof input.system_prompt === 'string' ? input.system_prompt : '',
    allowed_tools: stringList(input.allowed_tools),
    approval_required: stringList(input.approval_required),
    model_chain: chain,
    allowed_providers: providersInChain(chain),
    max_steps: wholeNumber(input.max_steps, 25),
    max_runtime_min: wholeNumber(input.max_runtime_min, 60),
    token_budget: wholeNumber(input.token_budget, 60000),
    resource_scopes: {},
  };
}

export async function saveProfile(rt: AgentRuntime, userId: string, input: SaveProfileInput): Promise<ProfileRecord> {
  const draft = draftFromInput(input);
  const errors = validateProfile(draft, profileRules());
  if (errors.length) throw new AgentInputError(errors.join(' '));
  const now = rt.now().toISOString();
  const fields = {
    name: draft.name.trim(),
    description: draft.description,
    system_prompt: draft.system_prompt.trim(),
    allowed_tools: [...new Set(draft.allowed_tools)],
    approval_required: [...new Set(draft.approval_required)],
    model_chain: draft.model_chain.flatMap((entry) => {
      if (entry.provider !== 'groq' && entry.provider !== 'google' && entry.provider !== 'openrouter') return [];
      return [{ provider: entry.provider, model: entry.model }];
    }),
    allowed_providers: draft.allowed_providers.flatMap((provider) =>
      provider === 'groq' || provider === 'google' || provider === 'openrouter' ? [provider] : []
    ),
    max_steps: draft.max_steps,
    max_runtime_min: draft.max_runtime_min,
    token_budget: draft.token_budget,
    resource_scopes: draft.resource_scopes,
  };

  if (input.id) {
    const existing = await rt.store.loadProfile(input.id, userId);
    if (!existing) throw new AgentInputError('Profile not found', 404);
    const next: ProfileRecord = { ...existing, ...fields, is_system: existing.is_system, updated_at: now };
    const saved = await rt.store.updateProfile(next);
    if (!saved) throw new AgentInputError('Profile not found', 404);
    return next;
  }

  const profile: ProfileRecord = {
    id: crypto.randomUUID(),
    user_id: userId,
    is_system: false,
    created_at: now,
    updated_at: now,
    ...fields,
  };
  await rt.store.insertProfile(profile);
  return profile;
}

export async function retryRun(rt: AgentRuntime, userId: string, runId: string): Promise<RunRecord> {
  const run = await ownedRun(rt, userId, runId);
  return createRun(rt, userId, run.command, run.profile_id, 'manual');
}
