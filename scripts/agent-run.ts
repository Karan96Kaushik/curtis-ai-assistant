/**
 * Drive one agent run locally, one step at a time, without SQS.
 *
 *   tsx scripts/agent-run.ts create --user <uuid> "Read my recent email"
 *   tsx scripts/agent-run.ts step --user <uuid> <runId>
 *   tsx scripts/agent-run.ts answer --user <uuid> <runId> "Use the work inbox"
 *   tsx scripts/agent-run.ts run --user <uuid> <runId>
 */
import { config } from 'dotenv';
import { productionRuntime } from '../amplify/functions/_shared/agent/runtime.js';
import { answerRun, createRun } from '../amplify/functions/_shared/agent/runs.js';
import { handleStep } from '../amplify/functions/_shared/agent/step.js';
import type { EnqueueMessage } from '../amplify/functions/_shared/agent/types.js';

config();
config({ path: '.env.local' });

process.env.SUPABASE_URL ||= process.env.VITE_SUPABASE_URL_CURTIS || '';
process.env.SUPABASE_PUBLISHABLE_KEY ||= process.env.VITE_SUPABASE_PUBLISHABLE_KEY_CURTIS || '';

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const userId = arg('--user') || process.env.AGENT_USER_ID || '';
  if (!userId) throw new Error('Pass --user <uuid> or set AGENT_USER_ID');
  const rt = productionRuntime();
  const inline: EnqueueMessage[] = [];
  rt.enqueue = async (message) => {
    inline.push(message);
    console.log(`[agent] next step ${message.expected_step}${message.delaySeconds ? ` in ${message.delaySeconds}s` : ''}`);
  };

  if (command === 'create') {
    const text = rest.filter((part) => !part.startsWith('--') && part !== userId).join(' ').trim();
    const run = await createRun(rt, userId, text);
    console.log(run.id, run.status);
    return;
  }

  const runId = rest.find((part) => /^[0-9a-f-]{36}$/i.test(part));
  if (!runId) throw new Error('A run id is required');

  if (command === 'answer') {
    const text = rest.filter((part) => part !== runId && !part.startsWith('--') && part !== userId).join(' ').trim();
    const run = await answerRun(rt, userId, runId, text);
    console.log(run.id, run.status);
    return;
  }

  if (command === 'step') {
    const loaded = await rt.store.loadRun(runId);
    if (!loaded || loaded.user_id !== userId) throw new Error('Run not found');
    const result = await handleStep({ run_id: runId, expected_step: loaded.step_count }, rt);
    console.log(result.outcome, loaded.step_count);
    return;
  }

  if (command === 'run') {
    for (let i = 0; i < 30; i += 1) {
      const loaded = await rt.store.loadRun(runId);
      if (!loaded || loaded.user_id !== userId) throw new Error('Run not found');
      if (loaded.status !== 'queued' && loaded.status !== 'running') {
        console.log(loaded.status, loaded.result_summary || loaded.error || '');
        return;
      }
      const result = await handleStep({ run_id: runId, expected_step: loaded.step_count }, rt);
      console.log(result.outcome);
      if (result.outcome !== 'continued') return;
    }
    return;
  }

  throw new Error('Use create, step, answer, or run');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
