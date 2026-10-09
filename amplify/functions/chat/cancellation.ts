import type { SupabaseClient } from '@supabase/supabase-js';

export function isCancelError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!err || typeof err !== 'object') return false;
  const name = 'name' in err ? String(err.name) : '';
  return name === 'AbortError' || name === 'APIUserAbortError';
}

function cancelColumnMissing(message: string): boolean {
  return /cancel_turn_id/i.test(message) && /does not exist|schema cache|could not find/i.test(message);
}

/**
 * Abort `controller` when this conversation's cancel_turn_id matches the turn.
 * Stops polling if the column has not been migrated yet.
 */
export function watchCancellation(
  db: SupabaseClient,
  conversationId: string,
  turnId: string | null,
  controller: AbortController
): () => void {
  if (!turnId) return () => {};

  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };

  const tick = async () => {
    if (stopped || controller.signal.aborted) return;
    const { data, error } = await db.from('conversations').select('cancel_turn_id').eq('id', conversationId).maybeSingle();
    if (stopped || controller.signal.aborted) return;
    if (error) {
      if (cancelColumnMissing(error.message)) stop();
      else console.warn('[chat] cancel check failed:', error.message);
      return;
    }
    const row = data as { cancel_turn_id?: string | null } | null;
    if (row?.cancel_turn_id === turnId) controller.abort();
  };

  void tick();
  timer = setInterval(() => void tick(), 800);
  return stop;
}
