import type { AgentStore } from './store.js';
import { getTool, presentToolResult, registryToolName } from './registry.js';
import { sanitizeToolError } from './text.js';
import type { EmailReader, RunRecord, ToolDef } from './types.js';

export interface ToolHost {
  store: AgentStore;
  email: EmailReader;
  now: () => Date;
}

export async function executeTool(
  rt: ToolHost,
  run: RunRecord,
  toolCallId: string,
  def: ToolDef,
  args: Record<string, unknown>
): Promise<string> {
  const claim = await rt.store.claimToolCall({
    runId: run.id,
    toolCallId,
    toolName: def.name,
    args,
    access: def.access,
  });
  if (claim.kind === 'done') {
    const stored = claim.result;
    if (stored && typeof stored === 'object' && 'text' in stored && typeof stored.text === 'string') return stored.text;
    return 'Tool already completed.';
  }
  if (claim.kind === 'inflight') {
    return 'A previous attempt did not finish. Do not retry this side effect.';
  }

  try {
    const result = await def.handler(args, { userId: run.user_id, runId: run.id, email: rt.email, now: rt.now() });
    const id = typeof args.id === 'string' ? args.id : run.id;
    const text = presentToolResult(def, result.text, id);
    await rt.store.completeToolCall(run.id, toolCallId, 'done', { text });
    run.consecutive_errors = 0;
    return text;
  } catch (err) {
    const text = sanitizeToolError(err);
    await rt.store.completeToolCall(run.id, toolCallId, 'error', { text });
    run.consecutive_errors += 1;
    return text;
  }
}

export function toolByName(name: string): ToolDef | undefined {
  return getTool(registryToolName(name));
}
