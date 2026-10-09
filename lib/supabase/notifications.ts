import {
  LOOKUP_TIMEOUT_MS,
  MAX_BODY_CHARS,
  MAX_ITEMS,
  TOOL_NAME,
  sanitizeContext,
} from '@/src/ai/phoneNotifications.js';
import { supabase } from '@/utils/supabase';

export { TOOL_NAME };

export interface PhoneNotificationItem {
  appName: string;
  title: string;
  text: string;
  category: string;
  postedAt: string;
}

export interface PhoneNotificationContext {
  durationMinutes: number;
  fetchedAt: string;
  truncated: boolean;
  items: PhoneNotificationItem[];
}

interface NotificationQueryRow {
  app_name: string | null;
  package_name: string | null;
  title: string | null;
  text: string | null;
  sub_text: string | null;
  big_text: string | null;
  category: string | null;
  posted_at?: string | null;
  created_at?: string | null;
}

function notificationBody(row: NotificationQueryRow): string {
  const big = (row.big_text || '').trim();
  const text = (row.text || '').trim();
  const sub = (row.sub_text || '').trim();
  const main = big.length >= text.length ? big : text;
  if (sub && sub !== main && !main.includes(sub)) return `${sub}\n${main}`.trim();
  return main;
}

function toItem(row: NotificationQueryRow, postedAt: string | null | undefined): PhoneNotificationItem | null {
  if (!postedAt) return null;
  return {
    appName: (row.app_name || row.package_name || '').trim(),
    title: (row.title || '').trim(),
    text: notificationBody(row).slice(0, MAX_BODY_CHARS),
    category: (row.category || '').trim(),
    postedAt,
  };
}

/**
 * Read the signed-in user's notification rows for the approved window.
 * The query itself is time-boxed so a stuck read cannot hold the chat turn open.
 */
export async function listPhoneNotifications(
  durationMinutes: number,
  signal?: AbortSignal
): Promise<PhoneNotificationContext> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  const userId = userData.user?.id;
  if (!userId) throw new Error('Sign in to read phone notifications.');

  const since = new Date(Date.now() - durationMinutes * 60_000).toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  if (signal?.aborted) controller.abort();

  try {
    const posted = await supabase
      .from('notifications')
      .select('app_name, package_name, title, text, sub_text, big_text, category, posted_at')
      .eq('user_id', userId)
      .gte('posted_at', since)
      .order('posted_at', { ascending: false })
      .limit(MAX_ITEMS + 1)
      .abortSignal(controller.signal);

    let rows = (posted.data ?? []) as NotificationQueryRow[];
    let error = posted.error;
    if (error && /posted_at/i.test(error.message) && /does not exist|schema cache|could not find/i.test(error.message)) {
      const created = await supabase
        .from('notifications')
        .select('app_name, package_name, title, text, sub_text, big_text, category, created_at')
        .eq('user_id', userId)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(MAX_ITEMS + 1)
        .abortSignal(controller.signal);
      rows = (created.data ?? []) as NotificationQueryRow[];
      error = created.error;
    }
    if (error) throw error;

    const truncated = rows.length > MAX_ITEMS;
    const items = rows
      .slice(0, MAX_ITEMS)
      .map((row) => toItem(row, row.posted_at ?? row.created_at))
      .filter((item): item is PhoneNotificationItem => item != null);

    const context = sanitizeContext(
      { durationMinutes, truncated, items },
      durationMinutes
    ) as PhoneNotificationContext;
    return context;
  } catch (err) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new Error('Reading phone notifications took too long.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
