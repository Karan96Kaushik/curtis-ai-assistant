import { HttpError } from './http.js';

const hits = new Map<string, number[]>();

/**
 * Sliding-window limit per caller. State lives in the warm execution
 * environment, so this is a burst guard rather than a global quota.
 */
export function enforceRateLimit(key: string, { limit, windowMs }: { limit: number; windowMs: number }): void {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    throw new HttpError(429, 'Too many requests — wait a moment and try again.');
  }
  recent.push(now);
  hits.set(key, recent);
}
