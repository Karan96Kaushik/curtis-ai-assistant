import type { Json } from '@/lib/supabase/types';

export interface PendingAction {
  tool: string;
  summary: string;
  createdAt: number;
  /** Set when Curtis is waiting to read phone notifications for this many minutes. */
  durationMinutes?: number;
}

const PENDING_TTL_MS = 30 * 60 * 1000;

const PHONE_TOOL = 'request_phone_notifications';
const MAX_PHONE_MINUTES = 24 * 60;

function phoneDuration(value: Record<string, unknown>): number | undefined {
  const direct = value.durationMinutes;
  const args = value.args;
  const fromArgs =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as Record<string, unknown>).duration_minutes
      : undefined;
  const raw = typeof direct === 'number' ? direct : fromArgs;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_PHONE_MINUTES) return undefined;
  return raw;
}

/** Narrow the stored jsonb; expired actions are treated as gone (the agent drops them too). */
export function parsePendingAction(value: Json | PendingAction | null, now = Date.now()): PendingAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { tool, summary, createdAt } = record;
  if (typeof tool !== 'string' || typeof summary !== 'string' || typeof createdAt !== 'number') return null;
  if (now - createdAt >= PENDING_TTL_MS) return null;
  const durationMinutes = tool === PHONE_TOOL ? phoneDuration(record) : undefined;
  return durationMinutes ? { tool, summary, createdAt, durationMinutes } : { tool, summary, createdAt };
}

const TOOL_LABELS: Record<string, string> = {
  jira_create: 'Create Jira issue',
  jira_update: 'Update Jira issue',
  jira_delete_comment: 'Delete Jira comment',
  github_create_tag: 'Create GitHub tag',
  wf_release_execute_pending: 'Run release step',
  request_phone_notifications: 'Read phone notifications',
};

export function pendingLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool.replace(/_/g, ' ');
}
