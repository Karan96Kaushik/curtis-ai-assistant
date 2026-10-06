import type { ConversationSummary } from '@/lib/supabase/types';

export interface ConversationGroup {
  label: string;
  items: ConversationSummary[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Bucket by recency (input is already sorted newest first). */
export function groupConversations(items: ConversationSummary[], now = new Date()): ConversationGroup[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const buckets: [string, (t: number) => boolean][] = [
    ['Today', (t) => t >= startOfToday],
    ['Yesterday', (t) => t >= startOfToday - DAY_MS],
    ['Previous 7 days', (t) => t >= startOfToday - 7 * DAY_MS],
    ['Previous 30 days', (t) => t >= startOfToday - 30 * DAY_MS],
    ['Older', () => true],
  ];
  const groups = buckets.map(([label]) => ({ label, items: [] as ConversationSummary[] }));
  for (const item of items) {
    const t = new Date(item.updated_at).getTime();
    const index = buckets.findIndex(([, match]) => match(t));
    groups[index].items.push(item);
  }
  return groups.filter((g) => g.items.length);
}

export function upsertConversation(
  items: ConversationSummary[],
  next: ConversationSummary
): ConversationSummary[] {
  return [next, ...items.filter((c) => c.id !== next.id)];
}

export const STARTER_PROMPTS = [
  { title: 'My open tickets', prompt: 'What are my open Jira tickets?' },
  { title: 'Work agenda', prompt: 'What should I work on today?' },
  { title: 'GitHub activity', prompt: 'Summarise my GitHub activity this month' },
  { title: 'What can you do?', prompt: 'What can you do?' },
];
