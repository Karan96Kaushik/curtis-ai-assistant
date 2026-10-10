import type { AgentEventRow, AgentProfileRow, AgentRunRow, Json } from '@/lib/supabase/types';
import { supabase } from '@/utils/supabase';

export async function listAgentProfiles(): Promise<AgentProfileRow[]> {
  const { data, error } = await supabase.from('agent_profiles').select('*').order('name', { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function listAgentRuns(): Promise<AgentRunRow[]> {
  const { data, error } = await supabase
    .from('agent_runs')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getAgentRun(id: string): Promise<AgentRunRow | null> {
  const { data, error } = await supabase.from('agent_runs').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function listAgentEvents(runId: string): Promise<AgentEventRow[]> {
  const { data, error } = await supabase.from('agent_events').select('*').eq('run_id', runId).order('seq', { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export function snapshotName(value: Json): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Agent';
  const name = value.name;
  return typeof name === 'string' && name ? name : 'Agent';
}

export function snapshotLimit(value: Json, key: 'max_steps' | 'token_budget'): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value[key];
  return typeof raw === 'number' ? raw : null;
}

export interface QuestionRequest {
  kind: 'question';
  question: string;
  options: string[];
}

export interface ApprovalRequest {
  kind: 'approval';
  tool: string;
  args: Record<string, unknown>;
  reason: string;
}

export function pendingRequest(value: Json | null): QuestionRequest | ApprovalRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.kind === 'question' && typeof value.question === 'string') {
    const options = Array.isArray(value.options) ? value.options.filter((item): item is string => typeof item === 'string') : [];
    return { kind: 'question', question: value.question, options };
  }
  if (value.kind === 'approval' && typeof value.tool === 'string') {
    const args = value.args && typeof value.args === 'object' && !Array.isArray(value.args) ? (value.args as Record<string, unknown>) : {};
    return {
      kind: 'approval',
      tool: value.tool,
      args,
      reason: typeof value.reason === 'string' ? value.reason : 'This action needs approval',
    };
  }
  return null;
}
