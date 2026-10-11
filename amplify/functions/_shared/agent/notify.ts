import { sendPushToUser } from '../fcm.js';

export async function notifyUser(
  userId: string,
  runId: string,
  kind: 'question' | 'approval' | 'done' | 'failed',
  text: string
): Promise<void> {
  const title =
    kind === 'question'
      ? 'Agent needs an answer'
      : kind === 'approval'
        ? 'Agent needs approval'
        : kind === 'done'
          ? 'Agent finished'
          : 'Agent failed';
  const body = text.replace(/\s+/g, ' ').trim().slice(0, 180) || 'Open the agent run.';
  const deepLink = `/agents/runs/${runId}`;
  const needsAttention = kind === 'question' || kind === 'approval';

  await sendPushToUser(userId, {
    title,
    body,
    category: 'status',
    channel: needsAttention ? 'urgent' : 'default',
    urgency: needsAttention ? 'high' : 'normal',
    notification_key: `agent-run:${runId}:${kind}`,
    deep_link: deepLink,
    only_alert_once: kind === 'done' || kind === 'failed',
    actions: [{ id: 'open', label: 'Open run' }],
    data: { link: deepLink, run_id: runId, kind },
  });
}
