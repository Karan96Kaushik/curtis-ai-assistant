import type { Json } from '@/lib/supabase/types';

export interface PendingAction {
  tool: string;
  summary: string;
  createdAt: number;
}

const PENDING_TTL_MS = 30 * 60 * 1000;

/** Narrow the stored jsonb; expired actions are treated as gone (the agent drops them too). */
export function parsePendingAction(value: Json | PendingAction | null, now = Date.now()): PendingAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { tool, summary, createdAt } = record;
  if (typeof tool !== 'string' || typeof summary !== 'string' || typeof createdAt !== 'number') return null;
  if (now - createdAt >= PENDING_TTL_MS) return null;
  return { tool, summary, createdAt };
}

const TOOL_LABELS: Record<string, string> = {
  jira_create: 'Create Jira issue',
  jira_update: 'Update Jira issue',
  jira_delete_comment: 'Delete Jira comment',
  github_create_tag: 'Create GitHub tag',
  wf_release_execute_pending: 'Run release step',
};

export function pendingLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool.replace(/_/g, ' ');
}
