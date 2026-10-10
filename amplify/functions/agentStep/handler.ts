import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { handleStep } from '../_shared/agent/step.js';
import { productionRuntime } from '../_shared/agent/runtime.js';

/** One queue record is one agent step. Failures go back to the queue, then the DLQ. */
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const rt = productionRuntime();
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      const body = JSON.parse(record.body) as { run_id?: unknown; expected_step?: unknown };
      if (typeof body.run_id !== 'string' || typeof body.expected_step !== 'number') {
        throw new Error('Step message is missing run_id or expected_step');
      }
      await handleStep({ run_id: body.run_id, expected_step: body.expected_step }, rt);
    } catch (err) {
      console.error('[agent-step] failed', record.messageId, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
