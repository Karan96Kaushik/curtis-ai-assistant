import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { requireEnv } from '../_shared/secrets.js';
import { claimDueJobs, reclaimStaleJobs, type ScheduledJobRecord } from '../_shared/scheduledJobs.js';
import { supabaseAsService } from '../_shared/supabaseUser.js';

const lambda = new LambdaClient({});

async function releaseClaim(job: ScheduledJobRecord): Promise<void> {
  if (!job.locked_at) return;
  const db = supabaseAsService();
  const { error } = await db
    .from('scheduled_jobs')
    .update({ status: 'pending', locked_at: null, updated_at: new Date().toISOString() })
    .eq('id', job.id)
    .eq('status', 'running')
    .eq('locked_at', job.locked_at);
  if (error) console.error(`[schedule-tick] release ${job.id} failed:`, error.message);
}

/** Claim due rows and start one runner each. EventBridge invokes this about once a minute. */
export const handler = async (): Promise<{ claimed: number; started: number }> => {
  const db = supabaseAsService();
  await reclaimStaleJobs(db);
  const jobs = await claimDueJobs(db, 5);
  const functionName = requireEnv('RUN_SCHEDULED_JOB_FUNCTION_NAME');
  let started = 0;

  for (const job of jobs) {
    if (!job.locked_at) continue;
    try {
      await lambda.send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: 'Event',
          Payload: Buffer.from(JSON.stringify({ jobId: job.id, lockedAt: job.locked_at })),
        })
      );
      started += 1;
    } catch (err) {
      console.error(`[schedule-tick] invoke ${job.id} failed:`, err);
      await releaseClaim(job);
    }
  }

  if (jobs.length) console.log(`[schedule-tick] claimed ${jobs.length}, started ${started}`);
  return { claimed: jobs.length, started };
};
