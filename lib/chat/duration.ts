/** Milliseconds between the user message and the reply that followed it. */
export function durationBeforeReply(
  messages: readonly { role: string; created_at: string }[],
  index: number
): number | null {
  const reply = messages[index];
  if (!reply || reply.role === 'user') return null;
  for (let i = index - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue;
    const start = Date.parse(messages[i].created_at);
    const end = Date.parse(reply.created_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
    return end - start;
  }
  return null;
}

/** Compact label such as "1.4s" or "2m 5s". */
export function formatResponseDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rem = total % 60;
  if (minutes < 60) return rem ? `${minutes}m ${rem}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin ? `${hours}h ${remMin}m` : `${hours}h`;
}
