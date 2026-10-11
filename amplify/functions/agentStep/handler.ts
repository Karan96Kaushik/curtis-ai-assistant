import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { productionRuntime } from '../_shared/agent/runtime.js';
import { failActiveRun, handleStep } from '../_shared/agent/step.js';

/** One queue record is one agent step. Unexpected errors fail the run instead of leaving it running. */
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const rt = productionRuntime();
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    let runId = '';
    try {
      const body = JSON.parse(record.body) as { run_id?: unknown; expected_step?: unknown };
      if (typeof body.run_id !== 'string' || typeof body.expected_step !== 'number') {
        throw new Error('Step message is missing run_id or expected_step');
      }
      runId = body.run_id;
      await handleStep({ run_id: body.run_id, expected_step: body.expected_step }, rt);
    } catch (err) {
      console.error('[agent-step] failed', record.messageId, err);
      let marked = false;
      if (runId) {
        try {
          marked = await failActiveRun(rt, runId, err);
        } catch (failErr) {
          console.error('[agent-step] fail-run failed', runId, failErr);
        }
      }
      if (!marked) batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
