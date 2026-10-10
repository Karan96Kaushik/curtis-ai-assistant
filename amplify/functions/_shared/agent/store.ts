import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AgentEvent,
  ChatMessage,
  EventType,
  PendingRequest,
  ProfileRecord,
  ProfileSnapshot,
  ProviderName,
  RunRecord,
  RunStatus,
  RunTrigger,
  ToolClaim,
} from './types.js';

type Row = Record<string, unknown>;

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function asProviders(value: unknown): ProviderName[] {
  return asStringArray(value).filter((item): item is ProviderName => item === 'groq' || item === 'google' || item === 'openrouter');
}

export function snapshotFromRow(value: unknown): ProfileSnapshot | null {
  const row = asObject(value);
  if (!row || typeof row.id !== 'string' || typeof row.system_prompt !== 'string') return null;
  const chain = Array.isArray(row.model_chain) ? row.model_chain : [];
  return {
    id: row.id,
    name: typeof row.name === 'string' ? row.name : 'Agent',
    description: typeof row.description === 'string' ? row.description : null,
    system_prompt: row.system_prompt,
    allowed_tools: asStringArray(row.allowed_tools),
    approval_required: asStringArray(row.approval_required),
    model_chain: chain.flatMap((entry) => {
      const item = asObject(entry);
      if (!item) return [];
      const provider = item.provider;
      const model = item.model;
      if ((provider !== 'groq' && provider !== 'google' && provider !== 'openrouter') || typeof model !== 'string') {
        return [];
      }
      return [{ provider, model }];
    }),
    allowed_providers: asProviders(row.allowed_providers),
    max_steps: typeof row.max_steps === 'number' ? row.max_steps : 25,
    max_runtime_min: typeof row.max_runtime_min === 'number' ? row.max_runtime_min : 60,
    token_budget: typeof row.token_budget === 'number' ? row.token_budget : 60000,
    resource_scopes: asObject(row.resource_scopes) ?? {},
  };
}

function asMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ChatMessage => {
    const row = asObject(item);
    return Boolean(row && typeof row.role === 'string');
  });
}

function asPending(value: unknown): PendingRequest | null {
  const row = asObject(value);
  if (!row || typeof row.tool_call_id !== 'string') return null;
  if (row.kind === 'question' && typeof row.question === 'string') {
    const options = asStringArray(row.options);
    return { kind: 'question', question: row.question, tool_call_id: row.tool_call_id, ...(options.length ? { options } : {}) };
  }
  if (row.kind === 'approval' && typeof row.tool === 'string') {
    return {
      kind: 'approval',
      tool: row.tool,
      args: asObject(row.args) ?? {},
      tool_call_id: row.tool_call_id,
      reason: typeof row.reason === 'string' ? row.reason : 'This action needs approval',
    };
  }
  return null;
}

export function runFromRow(row: Row): RunRecord | null {
  const snapshot = snapshotFromRow(row.profile_snapshot);
  if (!snapshot || typeof row.id !== 'string' || typeof row.user_id !== 'string') return null;
  const status = row.status;
  if (
    status !== 'queued' &&
    status !== 'running' &&
    status !== 'waiting_input' &&
    status !== 'waiting_approval' &&
    status !== 'done' &&
    status !== 'failed' &&
    status !== 'cancelled'
  ) {
    return null;
  }
  const trigger = row.trigger === 'schedule' || row.trigger === 'webhook' ? row.trigger : 'manual';
  return {
    id: row.id,
    user_id: row.user_id,
    profile_id: typeof row.profile_id === 'string' ? row.profile_id : snapshot.id,
    profile_snapshot: snapshot,
    command: typeof row.command === 'string' ? row.command : '',
    trigger,
    status,
    messages: asMessages(row.messages),
    summary: typeof row.summary === 'string' ? row.summary : '',
    scratchpad: typeof row.scratchpad === 'string' ? row.scratchpad : '',
    summary_until: typeof row.summary_until === 'number' ? row.summary_until : 0,
    pending_request: asPending(row.pending_request),
    result_summary: typeof row.result_summary === 'string' ? row.result_summary : null,
    error: typeof row.error === 'string' ? row.error : null,
    step_count: typeof row.step_count === 'number' ? row.step_count : 0,
    tokens_used: typeof row.tokens_used === 'number' ? row.tokens_used : 0,
    no_tool_streak: typeof row.no_tool_streak === 'number' ? row.no_tool_streak : 0,
    consecutive_errors: typeof row.consecutive_errors === 'number' ? row.consecutive_errors : 0,
    next_attempt_at: typeof row.next_attempt_at === 'string' ? row.next_attempt_at : null,
    started_at: typeof row.started_at === 'string' ? row.started_at : null,
    finished_at: typeof row.finished_at === 'string' ? row.finished_at : null,
    created_at: typeof row.created_at === 'string' ? row.created_at : new Date().toISOString(),
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : new Date().toISOString(),
  };
}

function profileFromRow(row: Row): ProfileRecord | null {
  const snapshot = snapshotFromRow({ ...row, id: row.id });
  if (!snapshot || typeof row.user_id !== 'string') return null;
  return {
    ...snapshot,
    user_id: row.user_id,
    is_system: row.is_system === true,
    created_at: typeof row.created_at === 'string' ? row.created_at : new Date().toISOString(),
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : new Date().toISOString(),
  };
}

export function mutableRunPatch(run: RunRecord): Row {
  return {
    messages: run.messages,
    summary: run.summary,
    scratchpad: run.scratchpad,
    summary_until: run.summary_until,
    pending_request: run.pending_request,
    result_summary: run.result_summary,
    error: run.error,
    step_count: run.step_count,
    tokens_used: run.tokens_used,
    no_tool_streak: run.no_tool_streak,
    consecutive_errors: run.consecutive_errors,
    next_attempt_at: run.next_attempt_at,
    started_at: run.started_at,
    finished_at: run.finished_at,
    updated_at: new Date().toISOString(),
  };
}

export interface AgentStore {
  loadRun(id: string): Promise<RunRecord | null>;
  insertRun(run: RunRecord): Promise<void>;
  transition(id: string, from: RunStatus[], to: RunStatus, patch: Partial<RunRecord>): Promise<RunRecord | null>;
  save(run: RunRecord): Promise<boolean>;
  insertEvent(event: AgentEvent): Promise<void>;
  nextEventSeq(runId: string): Promise<number>;
  claimToolCall(row: { runId: string; toolCallId: string; toolName: string; args: unknown; access: 'read' | 'write' }): Promise<ToolClaim>;
  completeToolCall(runId: string, toolCallId: string, status: 'done' | 'error', result: unknown): Promise<void>;
  addTokens(provider: string, source: string, tokens: number): Promise<void>;
  findInbox(userId: string): Promise<ProfileRecord | null>;
  insertProfile(profile: ProfileRecord): Promise<void>;
  updateProfile(profile: ProfileRecord): Promise<boolean>;
  loadProfile(id: string, userId: string): Promise<ProfileRecord | null>;
}

export class SupabaseAgentStore implements AgentStore {
  constructor(private readonly db: SupabaseClient) {}

  async loadRun(id: string): Promise<RunRecord | null> {
    const { data, error } = await this.db.from('agent_runs').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? runFromRow(data as Row) : null;
  }

  async insertRun(run: RunRecord): Promise<void> {
    const { error } = await this.db.from('agent_runs').insert(run);
    if (error) throw new Error(error.message);
  }

  async transition(id: string, from: RunStatus[], to: RunStatus, patch: Partial<RunRecord>): Promise<RunRecord | null> {
    const { data, error } = await this.db
      .from('agent_runs')
      .update({ ...patch, status: to, updated_at: new Date().toISOString() })
      .eq('id', id)
      .in('status', from)
      .select('*')
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? runFromRow(data as Row) : null;
  }

  async save(run: RunRecord): Promise<boolean> {
    const { data, error } = await this.db
      .from('agent_runs')
      .update(mutableRunPatch(run))
      .eq('id', run.id)
      .eq('status', run.status)
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    return Boolean(data);
  }

  async nextEventSeq(runId: string): Promise<number> {
    const { data, error } = await this.db
      .from('agent_events')
      .select('seq')
      .eq('run_id', runId)
      .order('seq', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const seq = data && typeof (data as Row).seq === 'number' ? ((data as Row).seq as number) : 0;
    return seq + 1;
  }

  async insertEvent(event: AgentEvent): Promise<void> {
    const { error } = await this.db.from('agent_events').insert({
      run_id: event.run_id,
      seq: event.seq,
      type: event.type,
      payload: event.payload,
    });
    if (error) throw new Error(error.message);
  }

  async claimToolCall(row: {
    runId: string;
    toolCallId: string;
    toolName: string;
    args: unknown;
    access: 'read' | 'write';
  }): Promise<ToolClaim> {
    const { error } = await this.db.from('agent_tool_calls').insert({
      run_id: row.runId,
      tool_call_id: row.toolCallId,
      tool_name: row.toolName,
      args: row.args ?? {},
      status: 'pending',
    });
    if (!error) return { kind: 'fresh' };
    if (error.code !== '23505') throw new Error(error.message);

    const existing = await this.db
      .from('agent_tool_calls')
      .select('status, result')
      .eq('run_id', row.runId)
      .eq('tool_call_id', row.toolCallId)
      .maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    const status = (existing.data as Row | null)?.status;
    if (status === 'done') return { kind: 'done', result: (existing.data as Row).result };
    if (row.access === 'read') return { kind: 'fresh' };
    return { kind: 'inflight' };
  }

  async completeToolCall(runId: string, toolCallId: string, status: 'done' | 'error', result: unknown): Promise<void> {
    const { error } = await this.db
      .from('agent_tool_calls')
      .update({ status, result })
      .eq('run_id', runId)
      .eq('tool_call_id', toolCallId);
    if (error) throw new Error(error.message);
  }

  async addTokens(provider: string, source: string, tokens: number): Promise<void> {
    const { error } = await this.db.rpc('increment_token_ledger', {
      p_day: new Date().toISOString().slice(0, 10),
      p_provider: provider,
      p_source: source,
      p_tokens: tokens,
    });
    if (error) console.error('[agent] token ledger', error.message);
  }

  async findInbox(userId: string): Promise<ProfileRecord | null> {
    const { data, error } = await this.db
      .from('agent_profiles')
      .select('*')
      .eq('user_id', userId)
      .eq('is_system', true)
      .eq('name', 'Inbox')
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? profileFromRow(data as Row) : null;
  }

  async insertProfile(profile: ProfileRecord): Promise<void> {
    const { error } = await this.db.from('agent_profiles').insert(profile);
    if (error) throw new Error(error.message);
  }

  async updateProfile(profile: ProfileRecord): Promise<boolean> {
    const { data, error } = await this.db
      .from('agent_profiles')
      .update({
        name: profile.name,
        description: profile.description,
        system_prompt: profile.system_prompt,
        allowed_tools: profile.allowed_tools,
        approval_required: profile.approval_required,
        model_chain: profile.model_chain,
        allowed_providers: profile.allowed_providers,
        max_steps: profile.max_steps,
        max_runtime_min: profile.max_runtime_min,
        token_budget: profile.token_budget,
        resource_scopes: profile.resource_scopes,
        updated_at: profile.updated_at,
      })
      .eq('id', profile.id)
      .eq('user_id', profile.user_id)
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    return Boolean(data);
  }

  async loadProfile(id: string, userId: string): Promise<ProfileRecord | null> {
    const { data, error } = await this.db.from('agent_profiles').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? profileFromRow(data as Row) : null;
  }
}

export type { EventType, RunTrigger };
