import { sendPushToUser } from '../fcm.js';

export async function notifyUser(
  userId: string,
  runId: string,
  kind: 'question' | 'approval' | 'done' | 'failed',
  text: string
): Promise<void> {
  const title =
    kind === 'question' ? 'Agent needs an answer' : kind === 'approval' ? 'Agent needs approval' : kind === 'done' ? 'Agent finished' : 'Agent failed';
  const body = text.replace(/\s+/g, ' ').trim().slice(0, 180) || 'Open the agent run.';
  await sendPushToUser(userId, {
    title,
    body,
    data: { link: `/agents/runs/${runId}`, run_id: runId },
  });
}
