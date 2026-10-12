import type { AgentRuntime } from './deps.js';
import { failActiveRun } from './step.js';

/** Quiet queued/running runs older than this are re-enqueued (or failed if over runtime). */
export const STALE_RUN_MS = 4 * 60_000;

export async function recoverStaleRuns(rt: AgentRuntime, now = rt.now()): Promise<{ recovered: number; failed: number }> {
  const olderThan = new Date(now.getTime() - STALE_RUN_MS).toISOString();
  const stale = await rt.store.listStaleRuns(olderThan, 20);
  let recovered = 0;
  let failed = 0;
  for (const run of stale) {
    // Still waiting on rate-limit / backoff — wakeWaitingRuns handles these.
    if (run.next_attempt_at && now.getTime() < Date.parse(run.next_attempt_at)) continue;

    const started = run.started_at ? Date.parse(run.started_at) : NaN;
    const overRuntime =
      Number.isFinite(started) && now.getTime() > started + run.profile_snapshot.max_runtime_min * 60_000;
    if (overRuntime) {
      const marked = await failActiveRun(rt, run.id, new Error('runtime_exceeded'));
      if (marked) failed += 1;
      continue;
    }
    await rt.enqueue({
      run_id: run.id,
      expected_step: run.step_count,
      dedupNonce: `recover:${now.toISOString()}`,
    });
    run.updated_at = now.toISOString();
    await rt.store.save(run);
    recovered += 1;
  }
  return { recovered, failed };
}

/** Re-enqueue runs whose next_attempt_at is due (FIFO cannot use DelaySeconds). */
export async function wakeWaitingRuns(rt: AgentRuntime, now = rt.now()): Promise<number> {
  const due = await rt.store.listWaitingDue(now.toISOString(), 20);
  let woken = 0;
  for (const run of due) {
    await rt.enqueue({
      run_id: run.id,
      expected_step: run.step_count,
      dedupNonce: `wait:${run.next_attempt_at}:${now.toISOString()}`,
    });
    run.updated_at = now.toISOString();
    await rt.store.save(run);
    woken += 1;
  }
  return woken;
}
