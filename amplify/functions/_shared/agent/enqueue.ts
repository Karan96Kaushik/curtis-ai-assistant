import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { EnqueueMessage } from './types.js';

const client = new SQSClient({});

/**
 * One step message per run. Dedup ids for the same step differ only when a retry must not collapse.
 * FIFO queues reject per-message DelaySeconds — delays use next_attempt_at + scheduleTick wake.
 */
export async function enqueueStep(message: EnqueueMessage): Promise<void> {
  const url = process.env.AGENT_STEP_QUEUE_URL?.trim();
  if (!url) {
    console.log(`[agent] queue unset; not enqueued run=${message.run_id} step=${message.expected_step}`);
    return;
  }
  if (message.delaySeconds && message.delaySeconds > 0) {
    console.log(
      `[agent] FIFO has no DelaySeconds; delay=${Math.floor(message.delaySeconds)}s deferred to next_attempt_at wake run=${message.run_id}`
    );
  }
  await client.send(
    new SendMessageCommand({
      QueueUrl: url,
      MessageBody: JSON.stringify({ run_id: message.run_id, expected_step: message.expected_step }),
      MessageGroupId: message.run_id.slice(0, 128),
      MessageDeduplicationId: `${message.run_id}:${message.expected_step}:${message.dedupNonce}`.slice(0, 128),
    })
  );
}
