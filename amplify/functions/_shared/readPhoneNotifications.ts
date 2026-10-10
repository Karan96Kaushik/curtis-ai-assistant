import phoneNotifications from '../../../src/ai/phoneNotifications.js';
import { supabaseAsService } from './supabaseUser.js';

const phone = phoneNotifications as unknown as {
  MAX_ITEMS: number;
  MAX_BODY_CHARS: number;
  LOOKUP_TIMEOUT_MS: number;
};

export interface PhoneNotificationItem {
  appName: string;
  title: string;
  text: string;
  category: string;
  postedAt: string;
}

interface NotificationQueryRow {
  app_name: string | null;
  package_name: string | null;
  title: string | null;
  text: string | null;
  sub_text: string | null;
  big_text: string | null;
  category: string | null;
  posted_at?: number | string | null;
  created_at?: number | string | null;
}

/** `posted_at` is a bigint: Android postTime in milliseconds, or unix seconds. */
function postedAtIso(value: number | string | null | undefined): string | null {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && /[T-]/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n >= 1e11 ? n : n * 1000;
  return new Date(ms).toISOString();
}

function notificationBody(row: NotificationQueryRow): string {
  const big = (row.big_text || '').trim();
  const text = (row.text || '').trim();
  const sub = (row.sub_text || '').trim();
  const main = big.length >= text.length ? big : text;
  if (sub && sub !== main && !main.includes(sub)) return `${sub}\n${main}`.trim();
  return main;
}

function toItem(row: NotificationQueryRow, postedAt: number | string | null | undefined): PhoneNotificationItem | null {
  const iso = postedAtIso(postedAt);
  if (!iso) return null;
  return {
    appName: (row.app_name || row.package_name || '').trim(),
    title: (row.title || '').trim(),
    text: notificationBody(row).slice(0, phone.MAX_BODY_CHARS),
    category: (row.category || '').trim(),
    postedAt: iso,
  };
}

/**
 * Read `userId`'s notification rows for the requested window.
 * Uses SUPABASE_SECRET_KEY_CURTIS so RLS does not block the agent. The user id
 * filter is the authorization boundary — never omit it.
 */
export async function readPhoneNotifications(
  userId: string,
  durationMinutes: number
): Promise<{ items: PhoneNotificationItem[]; truncated: boolean }> {
  if (!userId) throw new Error('No signed-in user for this turn.');

  const sinceMs = Date.now() - durationMinutes * 60_000;
  const db = supabaseAsService();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), phone.LOOKUP_TIMEOUT_MS);
  const limit = phone.MAX_ITEMS + 1;

  try {
    const posted = await db
      .from('notifications')
      .select('app_name, package_name, title, text, sub_text, big_text, category, posted_at')
      .eq('user_id', userId)
      .gte('posted_at', sinceMs)
      .order('posted_at', { ascending: false })
      .limit(limit)
      .abortSignal(controller.signal);

    let rows = (posted.data ?? []) as NotificationQueryRow[];
    let error = posted.error;
    if (error && /posted_at/i.test(error.message) && /does not exist|schema cache|could not find/i.test(error.message)) {
      const created = await db
        .from('notifications')
        .select('app_name, package_name, title, text, sub_text, big_text, category, created_at')
        .eq('user_id', userId)
        .gte('created_at', sinceMs)
        .order('created_at', { ascending: false })
        .limit(limit)
        .abortSignal(controller.signal);
      rows = (created.data ?? []) as NotificationQueryRow[];
      error = created.error;
    }
    if (error) {
      console.error('[phone] notifications select failed', error.message);
      throw new Error('Could not read phone notifications');
    }

    const truncated = rows.length > phone.MAX_ITEMS;
    const items = rows
      .slice(0, phone.MAX_ITEMS)
      .map((row) => toItem(row, row.posted_at ?? row.created_at))
      .filter((item): item is PhoneNotificationItem => item != null);
    return { items, truncated };
  } catch (err) {
    if (controller.signal.aborted) throw new Error('Reading phone notifications took too long.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
