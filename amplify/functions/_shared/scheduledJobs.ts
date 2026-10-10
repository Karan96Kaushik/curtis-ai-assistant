import { CronExpressionParser } from 'cron-parser';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isAgentModel } from '../../../lib/chat/models.js';
import time from '../../../src/util/time.js';

const { TZ, cronOptions, formatUK, normalizeRunAt } = time as {
  TZ: string;
  cronOptions(currentDate?: Date): { tz: string; currentDate: Date };
  formatUK(input?: Date | string | number): string;
  normalizeRunAt(raw: string): string;
};

const MAX_PROMPT_CHARS = 4000;
const MAX_DELAY_MINUTES = 365 * 24 * 60;
const PAST_SKEW_MS = 60_000;
const STALE_LOCK_MS = 20 * 60_000;
const JOB_COLUMNS =
  'id, user_id, conversation_id, prompt, run_at, cron, timezone, model, status, last_error, locked_at, created_at, updated_at';

export type ScheduledJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ScheduledJobRecord {
  id: string;
  user_id: string;
  conversation_id: string;
  prompt: string;
  run_at: string;
  cron: string | null;
  timezone: string;
  model: string | null;
  status: ScheduledJobStatus;
  last_error: string | null;
  locked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduledJobView {
  id: string;
  runAt: string;
  cron: string | null;
  prompt: string;
  status: ScheduledJobStatus;
  displayAt: string;
  timezone: string;
}

export interface ScheduleRequest {
  runInMinutes?: unknown;
  runAt?: unknown;
  cron?: unknown;
  prompt?: unknown;
  model?: unknown;
}

function dbFailure(action: string, error: { message: string }): Error {
  console.error(`[scheduler] ${action} failed:`, error.message);
  return new Error(`Could not ${action}`);
}

export function nextCronRun(cron: string, fromDate = new Date()): string {
  let interval;
  try {
    interval = CronExpressionParser.parse(cron, cronOptions(fromDate));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid cron expression: ${message}`);
  }
  return interval.next().toDate().toISOString();
}

/** Turn the tool arguments into a UTC instant plus an optional cron. */
export function resolveWhen(input: ScheduleRequest, now = Date.now()): { runAt: string; cron: string | null } {
  const hasMinutes = input.runInMinutes != null && input.runInMinutes !== '';
  const hasRunAt = typeof input.runAt === 'string' && input.runAt.trim() !== '';
  const hasCron = typeof input.cron === 'string' && input.cron.trim() !== '';
  const count = Number(hasMinutes) + Number(hasRunAt) + Number(hasCron);
  if (count !== 1) throw new Error('Provide exactly one of run_in_minutes, run_at, or cron');

  if (hasCron) {
    const cron = String(input.cron).trim();
    const from = new Date(now);
    const runAt = nextCronRun(cron, from);
    const following = nextCronRun(cron, new Date(new Date(runAt).getTime() + 1000));
    if (new Date(following).getTime() - new Date(runAt).getTime() < 2 * 60_000) {
      throw new Error('Cron must leave at least 2 minutes between runs');
    }
    return { runAt, cron };
  }

  let runAt: string;
  if (hasMinutes) {
    const mins = Number(input.runInMinutes);
    if (!Number.isFinite(mins) || mins < 0 || mins > MAX_DELAY_MINUTES) {
      throw new Error(`run_in_minutes must be between 0 and ${MAX_DELAY_MINUTES}`);
    }
    runAt = new Date(now + mins * 60_000).toISOString();
  } else {
    try {
      runAt = normalizeRunAt(String(input.runAt));
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  }
  if (new Date(runAt).getTime() < now - PAST_SKEW_MS) {
    throw new Error('That time is already in the past');
  }
  return { runAt, cron: null };
}

function viewOf(row: ScheduledJobRecord): ScheduledJobView {
  return {
    id: row.id,
    runAt: row.run_at,
    cron: row.cron,
    prompt: row.prompt,
    status: row.status,
    displayAt: formatUK(row.run_at),
    timezone: row.timezone || TZ,
  };
}

export async function createScheduledJob(
  db: SupabaseClient,
  userId: string,
  conversationId: string,
  input: ScheduleRequest
): Promise<ScheduledJobView> {
  const prompt = String(input.prompt ?? '').trim();
  if (!prompt) throw new Error('prompt is required');
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`prompt is too long (max ${MAX_PROMPT_CHARS} characters)`);
  }
  const { runAt, cron } = resolveWhen(input);
  const model = isAgentModel(input.model) ? input.model : null;

  const { data: conversation, error: conversationError } = await db
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('user_id', userId)
    .maybeSingle();
  if (conversationError) throw dbFailure('check the conversation', conversationError);
  if (!conversation) throw new Error('Conversation not found');

  const { data, error } = await db
    .from('scheduled_jobs')
    .insert({
      user_id: userId,
      conversation_id: conversationId,
      prompt,
      run_at: runAt,
      cron,
      timezone: TZ,
      model,
      status: 'pending',
    })
    .select(JOB_COLUMNS)
    .single();
  if (error) throw dbFailure('save the schedule', error);
  return viewOf(data as ScheduledJobRecord);
}

export async function listScheduledJobs(db: SupabaseClient, userId: string): Promise<ScheduledJobView[]> {
  const { data, error } = await db
    .from('scheduled_jobs')
    .select(JOB_COLUMNS)
    .eq('user_id', userId)
    .in('status', ['pending', 'running'])
    .order('run_at', { ascending: true })
    .limit(50);
  if (error) throw dbFailure('list schedules', error);
  return ((data ?? []) as ScheduledJobRecord[]).map(viewOf);
}

export async function cancelScheduledJob(db: SupabaseClient, userId: string, jobId: string): Promise<boolean> {
  const id = String(jobId ?? '').trim();
  if (!id) return false;
  const { data, error } = await db
    .from('scheduled_jobs')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (error) throw dbFailure('cancel the schedule', error);
  return Boolean(data);
}

/** Jobs left `running` after a crashed runner become pending again. */
export async function reclaimStaleJobs(db: SupabaseClient, now = Date.now()): Promise<void> {
  const staleBefore = new Date(now - STALE_LOCK_MS).toISOString();
  const finishedAt = new Date(now).toISOString();
  const { error: runError } = await db
    .from('scheduled_job_runs')
    .update({ status: 'failed', finished_at: finishedAt, error: 'Run did not finish' })
    .eq('status', 'running')
    .lt('started_at', staleBefore);
  if (runError) console.error('[scheduler] stale run reclaim failed:', runError.message);

  const { error } = await db
    .from('scheduled_jobs')
    .update({
      status: 'pending',
      locked_at: null,
      last_error: 'Previous run did not finish',
      updated_at: finishedAt,
    })
    .eq('status', 'running')
    .lt('locked_at', staleBefore);
  if (error) console.error('[scheduler] stale job reclaim failed:', error.message);
}

/** Claim up to `limit` due jobs. A second tick's update matches nothing. */
export async function claimDueJobs(db: SupabaseClient, limit: number, now = Date.now()): Promise<ScheduledJobRecord[]> {
  const nowIso = new Date(now).toISOString();
  const { data: due, error } = await db
    .from('scheduled_jobs')
    .select('id')
    .eq('status', 'pending')
    .lte('run_at', nowIso)
    .order('run_at', { ascending: true })
    .limit(limit);
  if (error) throw dbFailure('look up due schedules', error);

  const claimed: ScheduledJobRecord[] = [];
  for (const row of due ?? []) {
    const id = typeof row.id === 'string' ? row.id : '';
    if (!id) continue;
    const { data, error: claimError } = await db
      .from('scheduled_jobs')
      .update({ status: 'running', locked_at: nowIso, updated_at: nowIso })
      .eq('id', id)
      .eq('status', 'pending')
      .select(JOB_COLUMNS)
      .maybeSingle();
    if (claimError) {
      console.error(`[scheduler] claim ${id} failed:`, claimError.message);
      continue;
    }
    if (data) claimed.push(data as ScheduledJobRecord);
  }
  return claimed;
}

export async function loadRunningJob(
  db: SupabaseClient,
  jobId: string,
  lockedAt: string
): Promise<ScheduledJobRecord | null> {
  const { data, error } = await db
    .from('scheduled_jobs')
    .select(JOB_COLUMNS)
    .eq('id', jobId)
    .eq('status', 'running')
    .eq('locked_at', lockedAt)
    .maybeSingle();
  if (error) throw dbFailure('load the schedule', error);
  return (data as ScheduledJobRecord | null) ?? null;
}

export async function insertJobRun(db: SupabaseClient, job: ScheduledJobRecord): Promise<string> {
  const { data, error } = await db
    .from('scheduled_job_runs')
    .insert({ job_id: job.id, user_id: job.user_id, status: 'running' })
    .select('id')
    .single();
  if (error) throw dbFailure('log the run', error);
  return String((data as { id: string }).id);
}

export async function finishJobRun(
  db: SupabaseClient,
  runId: string,
  patch: {
    status: 'succeeded' | 'failed';
    reply: string | null;
    error: string | null;
    pushSent: number;
    pushFailed: number;
  }
): Promise<void> {
  const { error } = await db
    .from('scheduled_job_runs')
    .update({
      status: patch.status,
      finished_at: new Date().toISOString(),
      reply: patch.reply ? patch.reply.slice(0, 20000) : null,
      error: patch.error ? patch.error.slice(0, 2000) : null,
      push_sent: patch.pushSent,
      push_failed: patch.pushFailed,
    })
    .eq('id', runId);
  if (error) console.error('[scheduler] finish run failed:', error.message);
}

export async function settleJob(
  db: SupabaseClient,
  job: ScheduledJobRecord,
  lockedAt: string,
  outcome: 'ok' | 'fail' | 'drop',
  errorMessage: string | null
): Promise<void> {
  const nowIso = new Date().toISOString();
  const lastError = errorMessage ? errorMessage.slice(0, 2000) : null;
  const patch: Record<string, unknown> = {
    locked_at: null,
    updated_at: nowIso,
  };

  if (outcome === 'drop' || !job.cron) {
    patch.status = outcome === 'ok' ? 'completed' : outcome === 'drop' ? 'cancelled' : 'failed';
    patch.last_error = outcome === 'ok' ? null : lastError;
  } else {
    try {
      patch.status = 'pending';
      patch.run_at = nextCronRun(job.cron, new Date(Date.now() + 1000));
      patch.last_error = outcome === 'ok' ? null : lastError;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      patch.status = 'failed';
      patch.last_error = message.slice(0, 2000);
    }
  }

  const { data, error } = await db
    .from('scheduled_jobs')
    .update(patch)
    .eq('id', job.id)
    .eq('status', 'running')
    .eq('locked_at', lockedAt)
    .select('id')
    .maybeSingle();
  if (error) console.error(`[scheduler] settle ${job.id} failed:`, error.message);
  else if (!data) console.warn(`[scheduler] settle ${job.id} skipped; lock no longer matches`);
}
