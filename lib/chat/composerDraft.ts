/** Text to put back in the composer after a failed send. Keyed by conversation so a later chat does not pick it up. */
const pending = new Map<string, string>();
const listeners = new Set<(conversationId: string | null, text: string) => void>();

function key(conversationId: string | null): string {
  return conversationId ?? '';
}

export function restoreComposerDraft(conversationId: string | null, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  pending.set(key(conversationId), text);
  for (const listener of listeners) listener(conversationId, text);
}

export function takeComposerDraft(conversationId: string | null): string | null {
  const id = key(conversationId);
  const text = pending.get(id) ?? null;
  if (text != null) pending.delete(id);
  return text;
}

export function subscribeComposerDraft(listener: (conversationId: string | null, text: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
