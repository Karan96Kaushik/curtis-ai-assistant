import type { z } from 'zod';

export const RUN_STATUSES = [
  'queued',
  'running',
  'waiting_input',
  'waiting_approval',
  'done',
  'failed',
  'cancelled',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const EVENT_TYPES = [
  'started',
  'thought',
  'tool_call',
  'tool_result',
  'tool_blocked',
  'question',
  'answer',
  'approval_request',
  'approval',
  'summary',
  'provider_fallback',
  'rate_limited',
  'finished',
  'failed',
  'cancelled',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type ProviderName = 'groq' | 'google' | 'openrouter';

export type RunTrigger = 'manual' | 'schedule' | 'webhook';

export interface ModelRef {
  provider: ProviderName;
  model: string;
}

export interface ProfileSnapshot {
  id: string;
  name: string;
  description: string | null;
  system_prompt: string;
  allowed_tools: string[];
  approval_required: string[];
  model_chain: ModelRef[];
  allowed_providers: ProviderName[];
  max_steps: number;
  max_runtime_min: number;
  token_budget: number;
  resource_scopes: Record<string, unknown>;
}

export interface ProfileRecord extends ProfileSnapshot {
  user_id: string;
  is_system: boolean;
  created_at: string;
  updated_at: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface PendingQuestion {
  kind: 'question';
  question: string;
  options?: string[];
  tool_call_id: string;
}

export interface PendingApproval {
  kind: 'approval';
  tool: string;
  args: Record<string, unknown>;
  tool_call_id: string;
  reason: string;
}

export type PendingRequest = PendingQuestion | PendingApproval;

export interface RunRecord {
  id: string;
  user_id: string;
  profile_id: string;
  profile_snapshot: ProfileSnapshot;
  command: string;
  trigger: RunTrigger;
  status: RunStatus;
  messages: ChatMessage[];
  summary: string;
  scratchpad: string;
  summary_until: number;
  pending_request: PendingRequest | null;
  result_summary: string | null;
  error: string | null;
  step_count: number;
  tokens_used: number;
  no_tool_streak: number;
  consecutive_errors: number;
  next_attempt_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentEvent {
  id?: number;
  run_id: string;
  seq: number;
  type: EventType;
  payload: Record<string, unknown>;
  created_at?: string;
}

export type ToolAccess = 'read' | 'write';
export type ToolRisk = 'low' | 'medium' | 'high';
export type ToolIntegration =
  | 'phone'
  | 'push'
  | 'jira'
  | 'github'
  | 'web'
  | 'browser'
  | 'teams'
  | 'scheduler'
  | 'memory'
  | 'timesheet'
  | 'release'
  | 'core';

export interface EmailListItem {
  id: string;
  sender: string;
  subject: string;
  snippet: string;
  postedAt: string;
}

export interface EmailDetail {
  id: string;
  sender: string;
  subject: string;
  body: string;
  postedAt: string;
}

export interface EmailReader {
  list(userId: string, query: string | undefined, limit: number): Promise<EmailListItem[]>;
  get(userId: string, id: string): Promise<EmailDetail | null>;
}

export interface ToolCtx {
  userId: string;
  runId: string;
  email: EmailReader;
  now: Date;
}

export interface ToolDef {
  name: string;
  integration: ToolIntegration;
  access: ToolAccess;
  risk: ToolRisk;
  description: string;
  schema: z.ZodType;
  maxResultChars: number;
  /** Omitted tools are callable. False keeps a granted tool off the model until it is connected. */
  available?: boolean;
  /** Can send content outside the user's own devices. */
  outbound?: boolean;
  handler: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<{ text: string }>;
}

export interface ModelTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ParsedToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ProviderFallback {
  from: string;
  to: string;
  status: number;
}

export type ModelTurn =
  | {
      kind: 'ok';
      text: string;
      toolCalls: ParsedToolCall[];
      usage: { provider: ProviderName; model: string; tokens: number; latencyMs: number };
      fallbacks: ProviderFallback[];
    }
  | {
      kind: 'rate_limited';
      delaySeconds: number;
      fallbacks: ProviderFallback[];
    }
  | {
      kind: 'provider_error';
      message: string;
      fallbacks: ProviderFallback[];
    };

export interface EnqueueMessage {
  run_id: string;
  expected_step: number;
  delaySeconds?: number;
  /** Distinguishes a delayed retry of the same step from the original delivery. */
  dedupNonce: string;
}

export type StepOutcome =
  | { outcome: 'missing' | 'cancelled' | 'duplicate' | 'ignored' | 'lost_race' }
  | { outcome: 'paused'; status: 'waiting_input' | 'waiting_approval' }
  | { outcome: 'done' }
  | { outcome: 'failed'; error: string }
  | { outcome: 'continued'; step: number }
  | { outcome: 'requeued'; delaySeconds: number };

export interface ClaimedToolCall {
  kind: 'fresh' | 'inflight';
  result?: undefined;
}

export interface DoneToolCall {
  kind: 'done';
  result: unknown;
}

export type ToolClaim = ClaimedToolCall | DoneToolCall;
