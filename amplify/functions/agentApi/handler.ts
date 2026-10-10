import { HttpError, json, parseBody, withHttp } from '../_shared/http.js';
import { AgentInputError, answerRun, cancelRun, createRun, decideApproval, retryRun } from '../_shared/agent/runs.js';
import { productionRuntime } from '../_shared/agent/runtime.js';
import { requireAllowedCaller } from '../_shared/verifySupabaseAuth.js';

interface AgentRequest {
  action?: string;
  command?: string;
  profile_id?: string;
  id?: string;
  text?: string;
  decision?: string;
  edited_args?: unknown;
  note?: string;
}

function asId(value: string | undefined): string {
  if (!value || !/^[0-9a-f-]{36}$/i.test(value)) throw new HttpError(400, 'A run id is required');
  return value;
}

export const handler = withHttp('agentApi', async (event) => {
  const caller = await requireAllowedCaller(event);
  const body = parseBody<AgentRequest>(event);
  const rt = productionRuntime();

  try {
    if (body.action === 'create') {
      const run = await createRun(rt, caller.userId, body.command ?? '', body.profile_id || undefined);
      return json(200, { id: run.id, status: run.status });
    }
    if (body.action === 'answer') {
      const run = await answerRun(rt, caller.userId, asId(body.id), body.text ?? '');
      return json(200, { id: run.id, status: run.status });
    }
    if (body.action === 'approval') {
      if (body.decision !== 'approve' && body.decision !== 'deny') throw new HttpError(400, 'decision must be approve or deny');
      const run = await decideApproval(rt, caller.userId, asId(body.id), body.decision, body.edited_args, body.note);
      return json(200, { id: run.id, status: run.status });
    }
    if (body.action === 'cancel') {
      const run = await cancelRun(rt, caller.userId, asId(body.id));
      return json(200, { id: run.id, status: run.status });
    }
    if (body.action === 'retry') {
      const run = await retryRun(rt, caller.userId, asId(body.id));
      return json(200, { id: run.id, status: run.status });
    }
    throw new HttpError(400, 'Unknown action');
  } catch (err) {
    if (err instanceof AgentInputError) throw new HttpError(err.status, err.message);
    throw err;
  }
});
