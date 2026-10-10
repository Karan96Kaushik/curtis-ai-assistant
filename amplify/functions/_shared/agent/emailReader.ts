import type { SupabaseClient } from '@supabase/supabase-js';
import type { EmailDetail, EmailListItem, EmailReader } from './types.js';

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

interface NotificationRow {
  id?: number | string;
  app_name?: string | null;
  package_name?: string | null;
  title?: string | null;
  text?: string | null;
  sub_text?: string | null;
  big_text?: string | null;
  posted_at?: number | string | null;
  created_at?: number | string | null;
}

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

function bodyOf(row: NotificationRow): string {
  const big = (row.big_text || '').trim();
  const text = (row.text || '').trim();
  const sub = (row.sub_text || '').trim();
  const main = big.length >= text.length ? big : text;
  if (sub && sub !== main && !main.includes(sub)) return `${sub}\n${main}`.trim();
  return main;
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= 150 ? flat : `${flat.slice(0, 150)}…`;
}

/**
 * Phone-notification reads from the same table the chat tool uses.
 * There is no mailbox send credential; this path is read-only.
 */
export function supabaseEmailReader(db: SupabaseClient): EmailReader {
  return {
    async list(userId, query, limit) {
      const rows = await loadRecent(db, userId);
      const needle = query?.trim().toLowerCase();
      return rows
        .filter((row) => {
          if (!needle) return true;
          const hay = `${row.title ?? ''} ${bodyOf(row)} ${row.app_name ?? ''}`.toLowerCase();
          return hay.includes(needle);
        })
        .slice(0, limit)
        .map((row) => toListItem(row))
        .filter((item): item is EmailListItem => item != null);
    },
    async get(userId, id) {
      const numeric = Number(id);
      if (!Number.isInteger(numeric)) return null;
      const { data, error } = await db
        .from('notifications')
        .select('id, app_name, package_name, title, text, sub_text, big_text, posted_at')
        .eq('user_id', userId)
        .eq('id', numeric)
        .maybeSingle();
      if (error) throw new Error('Could not read email');
      if (!data) return null;
      const row = data as NotificationRow;
      const postedAt = postedAtIso(row.posted_at ?? row.created_at);
      if (!postedAt) return null;
      const detail: EmailDetail = {
        id: String(row.id),
        sender: (row.app_name || row.package_name || 'Mail').trim(),
        subject: (row.title || '(no subject)').trim(),
        body: bodyOf(row).slice(0, 3000),
        postedAt,
      };
      return detail;
    },
  };
}

function toListItem(row: NotificationRow): EmailListItem | null {
  const postedAt = postedAtIso(row.posted_at ?? row.created_at);
  if (row.id == null || !postedAt) return null;
  return {
    id: String(row.id),
    sender: (row.app_name || row.package_name || 'Mail').trim(),
    subject: (row.title || '(no subject)').trim(),
    snippet: snippet(bodyOf(row)),
    postedAt,
  };
}

async function loadRecent(db: SupabaseClient, userId: string): Promise<NotificationRow[]> {
  const sinceMs = Date.now() - WINDOW_MS;
  const posted = await db
    .from('notifications')
    .select('id, app_name, package_name, title, text, sub_text, big_text, posted_at')
    .eq('user_id', userId)
    .gte('posted_at', sinceMs)
    .order('posted_at', { ascending: false })
    .limit(40);
  if (!posted.error) return (posted.data ?? []) as NotificationRow[];
  if (!/posted_at/i.test(posted.error.message)) throw new Error('Could not read email');
  const created = await db
    .from('notifications')
    .select('id, app_name, package_name, title, text, sub_text, big_text, created_at')
    .eq('user_id', userId)
    .gte('created_at', sinceMs)
    .order('created_at', { ascending: false })
    .limit(40);
  if (created.error) throw new Error('Could not read email');
  return (created.data ?? []) as NotificationRow[];
}
