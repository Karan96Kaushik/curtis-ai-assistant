import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveAgentModel } from '../../../lib/chat/models.js';
import aiRouter from '../../../src/integrations/aiRouter.js';
import time from '../../../src/util/time.js';
import { sendPushToUser } from '../_shared/fcm.js';
import { HttpError } from '../_shared/http.js';
import { readEnv } from '../_shared/secrets.js';
import {
  finishJobRun,
  insertJobRun,
  loadRunningJob,
  settleJob,
  type ScheduledJobRecord,
} from '../_shared/scheduledJobs.js';
import { supabaseAsService } from '../_shared/supabaseUser.js';
import { executeConversationPrompt, loadOwnedConversation } from '../chat/conversationTurn.js';

const { formatUK } = time as { formatUK(input?: Date | string | number): string };

const { runWithTurn } = aiRouter as unknown as {
  runWithTurn<T>(ctx: { model: string; signal: AbortSignal; switches: { from: string; to: string }[] }, fn: () => Promise<T>): Promise<T>;
};

interface RunEvent {
  jobId?: string;
  lockedAt?: string;
}

function allowedEmail(email: string | null): boolean {
  const allowed = new Set(
    readEnv('ALLOWED_EMAILS')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
  return Boolean(email && allowed.has(email.toLowerCase()));
}

function wakeText(prompt: string): string {
  return [
    'Scheduled task — run this now:',
    '',
    prompt,
    '',
    `(This ran on a schedule at ${formatUK()}. Do the work in this turn. Do not schedule it again unless the instruction says to. Reply with what you found or did. This reply is posted in the chat and sent to the phone, so do not call send_push_notification just to deliver it.)`,
  ].join('\n');
}

function notificationBody(text: string, fallback: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const body = flat || fallback;
  return body.length > 180 ? `${body.slice(0, 179)}…` : body;
}

async function lookupUser(
  db: SupabaseClient,
  userId: string
): Promise<{ email: string | null; displayName: string; lookupFailed: boolean }> {
  try {
    const { data, error } = await db.auth.admin.getUserById(userId);
    if (error || !data.user) {
      console.warn('[scheduler] user lookup failed:', error?.message);
      return { email: null, displayName: 'there', lookupFailed: true };
    }
    const email = data.user.email ?? null;
    return { email, displayName: email?.split('@')[0] || 'there', lookupFailed: false };
  } catch (err) {
    console.warn('[scheduler] user lookup failed:', err);
    return { email: null, displayName: 'there', lookupFailed: true };
  }
}

async function runClaimed(job: ScheduledJobRecord, lockedAt: string): Promise<void> {
  const db = supabaseAsService();
  const runId = await insertJobRun(db, job);
  const user = await lookupUser(db, job.user_id);

  if (!user.lookupFailed && !allowedEmail(user.email)) {
    await finishJobRun(db, runId, {
      status: 'failed',
      reply: null,
      error: 'This account is not allowed to use Curtis',
      pushSent: 0,
      pushFailed: 0,
    });
    await settleJob(db, job, lockedAt, 'drop', 'This account is not allowed to use Curtis');
    return;
  }

  const switches: { from: string; to: string }[] = [];
  const model = resolveAgentModel(job.model, process.env.GROQ_MODEL);
  try {
    const conversation = await loadOwnedConversation(db, job.conversation_id, job.user_id);
    const result = await runWithTurn({ model, signal: new AbortController().signal, switches }, () =>
      executeConversationPrompt({
        db,
        userId: job.user_id,
        user: { id: job.user_id, email: user.email, displayName: user.displayName },
        conversation,
        text: `Scheduled task\n\n${job.prompt}`,
        agentText: wakeText(job.prompt),
        model,
        switches,
      })
    );

    const failed = result.kind !== 'ok' || result.reply.role === 'error';
    const replyText = result.kind === 'cancelled' ? '' : result.reply.content;
    let pushSent = 0;
    let pushFailed = 0;
    try {
      const push = await sendPushToUser(job.user_id, {
        title: failed ? 'Scheduled task failed' : 'Scheduled task',
        body: notificationBody(replyText, failed ? 'The scheduled task failed.' : 'The scheduled task finished.'),
        data: { conversationId: job.conversation_id, jobId: job.id },
      });
      pushSent = push.sent;
      pushFailed = push.failed;
    } catch (err) {
      pushFailed = 1;
      console.error(`[scheduler] push for ${job.id} failed:`, err);
    }

    await finishJobRun(db, runId, {
      status: failed ? 'failed' : 'succeeded',
      reply: replyText || null,
      error: failed ? (replyText || 'The scheduled task failed').slice(0, 2000) : null,
      pushSent,
      pushFailed,
    });
    await settleJob(db, job, lockedAt, failed ? 'fail' : 'ok', failed ? replyText || 'The scheduled task failed' : null);
  } catch (err) {
    const message = err instanceof HttpError ? err.message : err instanceof Error ? err.message : String(err);
    const missingConversation = err instanceof HttpError && err.status === 404;
    console.error(`[scheduler] job ${job.id} failed:`, message);
    await finishJobRun(db, runId, {
      status: 'failed',
      reply: null,
      error: message,
      pushSent: 0,
      pushFailed: 0,
    });
    await settleJob(db, job, lockedAt, missingConversation ? 'drop' : 'fail', message);
  }
}

/** One claimed job. Always returns so an async invoke is not retried after we have settled the row. */
export const handler = async (event: RunEvent = {}): Promise<void> => {
  const jobId = event.jobId;
  const lockedAt = event.lockedAt;
  if (!jobId || !lockedAt) {
    console.error('[scheduler] invocation missing jobId or lockedAt');
    return;
  }
  try {
    const job = await loadRunningJob(supabaseAsService(), jobId, lockedAt);
    if (!job) {
      console.warn(`[scheduler] job ${jobId} is not running under this lock`);
      return;
    }
    await runClaimed(job, lockedAt);
  } catch (err) {
    console.error(`[scheduler] job ${jobId} crashed:`, err);
  }
};
