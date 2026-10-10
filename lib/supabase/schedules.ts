import { supabase } from '@/utils/supabase';
import type { ScheduledJobRow, ScheduledJobRunRow } from './types';

export async function listScheduledJobs(): Promise<ScheduledJobRow[]> {
  const { data, error } = await supabase
    .from('scheduled_jobs')
    .select(
      'id, user_id, conversation_id, prompt, run_at, cron, timezone, model, status, last_error, locked_at, created_at, updated_at'
    )
    .order('updated_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return data ?? [];
}

export async function listScheduledJobRuns(): Promise<ScheduledJobRunRow[]> {
  const { data, error } = await supabase
    .from('scheduled_job_runs')
    .select('id, job_id, user_id, status, started_at, finished_at, reply, error, push_sent, push_failed')
    .order('started_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return data ?? [];
}

/** Cancel a job that has not started. Returns false when it is no longer pending. */
export async function cancelScheduledJob(id: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('scheduled_jobs')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}
