import type { AgentStore } from './store.js';
import type { AgentEvent, ChatMessage, EventType, RunRecord, ToolClaim } from './types.js';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** In-memory store for the step-loop tests. */
export class MemoryAgentStore implements AgentStore {
  readonly runs = new Map<string, RunRecord>();
  readonly events: AgentEvent[] = [];
  readonly calls = new Map<string, { status: 'pending' | 'done' | 'error'; result: unknown }>();
  readonly profiles = new Map<string, import('./types.js').ProfileRecord>();
  tokens: { provider: string; source: string; tokens: number }[] = [];

  async loadRun(id: string): Promise<RunRecord | null> {
    const run = this.runs.get(id);
    return run ? clone(run) : null;
  }

  async insertRun(run: RunRecord): Promise<void> {
    this.runs.set(run.id, clone(run));
  }

  async transition(
    id: string,
    from: RunRecord['status'][],
    to: RunRecord['status'],
    patch: Partial<RunRecord>
  ): Promise<RunRecord | null> {
    const run = this.runs.get(id);
    if (!run || !from.includes(run.status)) return null;
    const next = { ...run, ...clone(patch), status: to, updated_at: new Date().toISOString() };
    this.runs.set(id, next);
    return clone(next);
  }

  async save(run: RunRecord): Promise<boolean> {
    const current = this.runs.get(run.id);
    if (!current || current.status !== run.status) return false;
    this.runs.set(run.id, clone(run));
    return true;
  }

  async nextEventSeq(runId: string): Promise<number> {
    const seqs = this.events.filter((event) => event.run_id === runId).map((event) => event.seq);
    return (seqs.length ? Math.max(...seqs) : 0) + 1;
  }

  async insertEvent(event: AgentEvent): Promise<void> {
    this.events.push(clone(event));
  }

  async claimToolCall(row: {
    runId: string;
    toolCallId: string;
    toolName: string;
    args: unknown;
    access: 'read' | 'write';
  }): Promise<ToolClaim> {
    const key = `${row.runId}:${row.toolCallId}`;
    const existing = this.calls.get(key);
    if (!existing) {
      this.calls.set(key, { status: 'pending', result: null });
      return { kind: 'fresh' };
    }
    if (existing.status === 'done') return { kind: 'done', result: existing.result };
    if (row.access === 'read') return { kind: 'fresh' };
    return { kind: 'inflight' };
  }

  async completeToolCall(runId: string, toolCallId: string, status: 'done' | 'error', result: unknown): Promise<void> {
    this.calls.set(`${runId}:${toolCallId}`, { status, result });
  }

  async addTokens(provider: string, source: string, tokens: number): Promise<void> {
    this.tokens.push({ provider, source, tokens });
  }

  async findInbox(userId: string) {
    for (const profile of this.profiles.values()) {
      if (profile.user_id === userId && profile.is_system && profile.name === 'Inbox') return clone(profile);
    }
    return null;
  }

  async insertProfile(profile: import('./types.js').ProfileRecord): Promise<void> {
    this.profiles.set(profile.id, clone(profile));
  }

  async updateProfile(profile: import('./types.js').ProfileRecord): Promise<boolean> {
    const current = this.profiles.get(profile.id);
    if (!current || current.user_id !== profile.user_id) return false;
    this.profiles.set(profile.id, clone({ ...profile, is_system: current.is_system }));
    return true;
  }

  async loadProfile(id: string, userId: string) {
    const profile = this.profiles.get(id);
    if (!profile || profile.user_id !== userId) return null;
    return clone(profile);
  }
}

export function eventsOf(store: MemoryAgentStore, runId: string, type?: EventType): AgentEvent[] {
  return store.events.filter((event) => event.run_id === runId && (!type || event.type === type));
}

export function messageText(messages: ChatMessage[], role: ChatMessage['role']): string[] {
  return messages.filter((message) => message.role === role).map((message) => message.content ?? '');
}
