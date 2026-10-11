import type { SupabaseClient } from '@supabase/supabase-js';

const LOOKUP_TIMEOUT_MS = 8_000;
const MAX_SEARCH = 15;
const MAX_BODY = 600;
const STALE_SYNC_MS = 60 * 60_000;

/** Banking, OTP, and authenticator apps stay hidden unless a profile lists them in allowed_apps. */
const SENSITIVE_APP =
  /\b(otp|authenticator|2fa|banking|bank|paypal|monzo|starling|chase|capital.?one|revolut|wise|wallet|password|verification)\b/i;

export interface NotificationRow {
  id: number;
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

export interface NotificationItem {
  id: string;
  app: string;
  sender: string;
  title: string;
  snippet: string;
  postedAt: string;
}

export interface CoverageNote {
  text: string;
  stale: boolean;
  lastDataAt: string | null;
  lastDeviceSyncAt: string | null;
}

export interface SearchQuery {
  app?: string;
  sender?: string;
  text?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface NotificationStore {
  search(userId: string, allowedApps: string[], query: SearchQuery, now: Date): Promise<{ items: NotificationItem[]; coverage: CoverageNote; nextOffset: number | null }>;
  digest(
    userId: string,
    allowedApps: string[],
    since: string,
    groupBy: 'app' | 'sender',
    now: Date
  ): Promise<{ text: string; coverage: CoverageNote }>;
  get(userId: string, allowedApps: string[], id: string, now: Date): Promise<{ item: NotificationItem | null; body: string; coverage: CoverageNote }>;
  listApps(userId: string, allowedApps: string[], now: Date): Promise<{ apps: string[]; coverage: CoverageNote }>;
  loadForDraft(userId: string, allowedApps: string[], id: string): Promise<NotificationRow | null>;
}

function postedAtMs(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && /[T-]/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n >= 1e11 ? n : n * 1000;
}

function postedAtIso(value: number | string | null | undefined): string | null {
  const ms = postedAtMs(value);
  return ms == null ? null : new Date(ms).toISOString();
}

function bodyOf(row: NotificationRow): string {
  const big = (row.big_text || '').trim();
  const text = (row.text || '').trim();
  const sub = (row.sub_text || '').trim();
  const main = big.length >= text.length ? big : text;
  if (sub && sub !== main && !main.includes(sub)) return `${sub}\n${main}`.trim();
  return main;
}

/** Mask OTP codes, card numbers, and password-reset style URLs before they reach a model. */
export function redactSensitive(text: string): string {
  let out = text;
  out = out.replace(/\b(?:code|otp|passcode|pin|verification(?:\s+code)?)\b[\w\s:#-]{0,16}?(\d{3,8})\b/gi, (match) =>
    match.replace(/\d{3,8}/, '[redacted-code]')
  );
  out = out.replace(/\b(\d{3,8})\b(?=[^\d\n]{0,24}\b(?:code|otp|passcode|pin|verification)\b)/gi, '[redacted-code]');
  out = out.replace(/\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, '[redacted-card]');
  out = out.replace(/https?:\/\/[^\s]+(?:reset|password|verify|token=)[^\s]*/gi, '[redacted-link]');
  return out;
}

export function isSensitiveApp(app: string, packageName: string): boolean {
  return SENSITIVE_APP.test(`${app} ${packageName}`);
}

export function appAllowed(app: string, packageName: string, allowedApps: string[]): boolean {
  const label = (app || packageName || '').trim();
  const pkg = (packageName || '').trim();
  const sensitive = isSensitiveApp(label, pkg);
  if (!allowedApps.length) return !sensitive;
  const needles = allowedApps.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const hay = `${label} ${pkg}`.toLowerCase();
  return needles.some((needle) => hay.includes(needle));
}

function toItem(row: NotificationRow): NotificationItem | null {
  const postedAt = postedAtIso(row.posted_at ?? row.created_at);
  if (row.id == null || !postedAt) return null;
  const app = (row.app_name || row.package_name || 'App').trim();
  const title = redactSensitive((row.title || '(no title)').trim());
  const body = redactSensitive(bodyOf(row));
  const snippet = body.replace(/\s+/g, ' ').trim();
  return {
    id: String(row.id),
    app,
    sender: title,
    title,
    snippet: snippet.length <= 150 ? snippet : `${snippet.slice(0, 150)}…`,
    postedAt,
  };
}

function parseBound(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : fallback;
}

function dedupeKey(row: NotificationRow): string {
  const app = (row.app_name || row.package_name || '').trim().toLowerCase();
  const title = (row.title || '').trim().toLowerCase();
  const body = bodyOf(row).replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 80);
  return `${app}|${title}|${body}`;
}

function formatCoverage(coverage: CoverageNote): string {
  return coverage.text;
}

async function loadCoverage(db: SupabaseClient, userId: string, now: Date): Promise<CoverageNote> {
  const nowMs = now.getTime();
  let lastDataAt: string | null = null;
  const latest = await db
    .from('notifications')
    .select('posted_at, created_at')
    .eq('user_id', userId)
    .order('posted_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latest.error && latest.data) {
    lastDataAt = postedAtIso(
      (latest.data as { posted_at?: number | string | null; created_at?: number | string | null }).posted_at ??
        (latest.data as { created_at?: number | string | null }).created_at
    );
  }

  let lastDeviceSyncAt: string | null = null;
  const device = await db
    .from('device_tokens')
    .select('updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!device.error && device.data && typeof (device.data as { updated_at?: string }).updated_at === 'string') {
    lastDeviceSyncAt = (device.data as { updated_at: string }).updated_at;
  }

  const dataMs = lastDataAt ? Date.parse(lastDataAt) : NaN;
  const syncMs = lastDeviceSyncAt ? Date.parse(lastDeviceSyncAt) : NaN;
  const freshest = Math.max(Number.isFinite(dataMs) ? dataMs : 0, Number.isFinite(syncMs) ? syncMs : 0);
  const stale = !freshest || nowMs - freshest > STALE_SYNC_MS;
  const through = lastDataAt ? new Date(lastDataAt).toISOString().slice(11, 16) : 'unknown';
  const syncAgo =
    Number.isFinite(syncMs) && syncMs > 0
      ? `${Math.max(1, Math.round((nowMs - syncMs) / 60_000))} min ago`
      : 'no device token';
  const warn = stale ? ' Warning: listener may be down or the phone is offline.' : '';
  return {
    text: `Coverage: data complete through ${through} UTC; last device sync ${syncAgo}.${warn}`,
    stale,
    lastDataAt,
    lastDeviceSyncAt,
  };
}

async function fetchWindow(
  db: SupabaseClient,
  userId: string,
  sinceMs: number,
  untilMs: number,
  limit: number
): Promise<NotificationRow[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const posted = await db
      .from('notifications')
      .select('id, app_name, package_name, title, text, sub_text, big_text, category, posted_at')
      .eq('user_id', userId)
      .gte('posted_at', sinceMs)
      .lte('posted_at', untilMs)
      .order('posted_at', { ascending: false })
      .limit(Math.min(200, Math.max(limit * 4, 40)))
      .abortSignal(controller.signal);
    if (!posted.error) return (posted.data ?? []) as NotificationRow[];
    if (!/posted_at/i.test(posted.error.message)) throw new Error('Could not read notifications');
    const created = await db
      .from('notifications')
      .select('id, app_name, package_name, title, text, sub_text, big_text, category, created_at')
      .eq('user_id', userId)
      .gte('created_at', sinceMs)
      .lte('created_at', untilMs)
      .order('created_at', { ascending: false })
      .limit(Math.min(200, Math.max(limit * 4, 40)))
      .abortSignal(controller.signal);
    if (created.error) throw new Error('Could not read notifications');
    return (created.data ?? []) as NotificationRow[];
  } finally {
    clearTimeout(timer);
  }
}

function filterRows(rows: NotificationRow[], allowedApps: string[], query: SearchQuery): NotificationRow[] {
  const appNeedle = query.app?.trim().toLowerCase();
  const senderNeedle = query.sender?.trim().toLowerCase();
  const textNeedle = query.text?.trim().toLowerCase();
  const seen = new Set<string>();
  const out: NotificationRow[] = [];
  for (const row of rows) {
    const app = (row.app_name || '').trim();
    const pkg = (row.package_name || '').trim();
    if (!appAllowed(app, pkg, allowedApps)) continue;
    if (appNeedle && !`${app} ${pkg}`.toLowerCase().includes(appNeedle)) continue;
    const title = (row.title || '').toLowerCase();
    const body = bodyOf(row).toLowerCase();
    if (senderNeedle && !title.includes(senderNeedle)) continue;
    if (textNeedle && !`${title} ${body}`.includes(textNeedle)) continue;
    const key = dedupeKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export function supabaseNotificationStore(db: SupabaseClient): NotificationStore {
  return {
    async search(userId, allowedApps, query, now) {
      const untilMs = parseBound(query.until, now.getTime());
      const sinceMs = parseBound(query.since, untilMs - 24 * 60 * 60_000);
      const limit = Math.min(MAX_SEARCH, Math.max(1, query.limit ?? 10));
      const offset = Math.max(0, query.offset ?? 0);
      const rows = filterRows(await fetchWindow(db, userId, sinceMs, untilMs, limit + offset + 5), allowedApps, query);
      const page = rows.slice(offset, offset + limit);
      const items = page.map(toItem).filter((item): item is NotificationItem => item != null);
      const coverage = await loadCoverage(db, userId, now);
      const nextOffset = offset + limit < rows.length ? offset + limit : null;
      return { items, coverage, nextOffset };
    },

    async digest(userId, allowedApps, since, groupBy, now) {
      const sinceMs = parseBound(since, now.getTime() - 24 * 60 * 60_000);
      const rows = filterRows(await fetchWindow(db, userId, sinceMs, now.getTime(), 80), allowedApps, {});
      const counts = new Map<string, number>();
      for (const row of rows) {
        const key =
          groupBy === 'app'
            ? (row.app_name || row.package_name || 'App').trim()
            : (row.title || '(unknown)').trim().slice(0, 80);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
      const coverage = await loadCoverage(db, userId, now);
      const lines = [
        formatCoverage(coverage),
        `Digest since ${new Date(sinceMs).toISOString()} (${rows.length} unique previews, grouped by ${groupBy}):`,
        ...ranked.map(([name, count]) => `${count} · ${redactSensitive(name)}`),
        'These are notification previews, not full messages.',
      ];
      return { text: lines.join('\n'), coverage };
    },

    async get(userId, allowedApps, id, now) {
      const numeric = Number(id);
      const coverage = await loadCoverage(db, userId, now);
      if (!Number.isInteger(numeric)) return { item: null, body: '', coverage };
      const { data, error } = await db
        .from('notifications')
        .select('id, app_name, package_name, title, text, sub_text, big_text, category, posted_at')
        .eq('user_id', userId)
        .eq('id', numeric)
        .maybeSingle();
      if (error) throw new Error('Could not read notification');
      if (!data) return { item: null, body: '', coverage };
      const row = data as NotificationRow;
      if (!appAllowed(row.app_name || '', row.package_name || '', allowedApps)) {
        return { item: null, body: '', coverage };
      }
      const item = toItem(row);
      const body = redactSensitive(bodyOf(row)).slice(0, MAX_BODY);
      return { item, body, coverage };
    },

    async listApps(userId, allowedApps, now) {
      const sinceMs = now.getTime() - 7 * 24 * 60 * 60_000;
      const rows = filterRows(await fetchWindow(db, userId, sinceMs, now.getTime(), 100), allowedApps, {});
      const apps = [...new Set(rows.map((row) => (row.app_name || row.package_name || 'App').trim()))].sort();
      const coverage = await loadCoverage(db, userId, now);
      return { apps, coverage };
    },

    async loadForDraft(userId, allowedApps, id) {
      const numeric = Number(id);
      if (!Number.isInteger(numeric)) return null;
      const { data, error } = await db
        .from('notifications')
        .select('id, app_name, package_name, title, text, sub_text, big_text, category, posted_at')
        .eq('user_id', userId)
        .eq('id', numeric)
        .maybeSingle();
      if (error || !data) return null;
      const row = data as NotificationRow;
      if (!appAllowed(row.app_name || '', row.package_name || '', allowedApps)) return null;
      return row;
    },
  };
}

export function formatSearchResult(
  items: NotificationItem[],
  coverage: CoverageNote,
  nextOffset: number | null
): string {
  const lines = [
    formatCoverage(coverage),
    'Notification previews (not full messages):',
    ...items.map((item) => `${item.id} | ${item.app} | ${item.sender} | ${item.snippet}`),
  ];
  if (!items.length) lines.push('No matching notifications.');
  if (nextOffset != null) lines.push(`More available. Call get_more with offset ${nextOffset}.`);
  return lines.join('\n');
}

/** Build a user-opened reply link. Contact must come from stored notification fields. */
export function replyLinkFromNotification(row: NotificationRow, body: string): { channel: string; link: string } | null {
  const hay = `${row.app_name ?? ''} ${row.package_name ?? ''} ${row.title ?? ''} ${bodyOf(row)}`;
  const email = hay.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  if (email && /gmail|outlook|mail|proton|yahoo|email|superhuman/i.test(hay)) {
    return { channel: 'email', link: `mailto:${email}?body=${encodeURIComponent(body.slice(0, 1500))}` };
  }
  const phone = hay.match(/\+?\d[\d\s()-]{7,}\d/)?.[0]?.replace(/[^\d+]/g, '');
  if (phone && /whatsapp|wa\.me/i.test(hay)) {
    const digits = phone.replace(/\D/g, '');
    return { channel: 'whatsapp', link: `https://wa.me/${digits}?text=${encodeURIComponent(body.slice(0, 1500))}` };
  }
  if (email) {
    return { channel: 'email', link: `mailto:${email}?body=${encodeURIComponent(body.slice(0, 1500))}` };
  }
  return null;
}
