import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { EnqueueMessage } from './types.js';

const client = new SQSClient({});

/** One step message per run. Dedup ids for the same step differ only when a retry must not collapse. */
export async function enqueueStep(message: EnqueueMessage): Promise<void> {
  const url = process.env.AGENT_STEP_QUEUE_URL?.trim();
  if (!url) {
    console.log(`[agent] queue unset; not enqueued run=${message.run_id} step=${message.expected_step}`);
    return;
  }
  const delaySeconds = Math.max(0, Math.min(900, Math.floor(message.delaySeconds ?? 0)));
  await client.send(
    new SendMessageCommand({
      QueueUrl: url,
      MessageBody: JSON.stringify({ run_id: message.run_id, expected_step: message.expected_step }),
      MessageGroupId: message.run_id.slice(0, 128),
      MessageDeduplicationId: `${message.run_id}:${message.expected_step}:${message.dedupNonce}`.slice(0, 128),
      DelaySeconds: delaySeconds,
    })
  );
}
