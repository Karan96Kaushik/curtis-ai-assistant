import type { SupabaseClient } from '@supabase/supabase-js';

const LOOKUP_TIMEOUT_MS = 8_000;
const MAX_SEARCH = 40;
const DEFAULT_SEARCH = 20;
const MAX_FETCH = 500;
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const MAX_BODY = 600;

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
  exclude_app?: string;
  sender?: string;
  text?: string;
  category?: string;
  since?: string;
  until?: string;
  hours?: number;
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
  appStats(
    userId: string,
    allowedApps: string[],
    query: Pick<SearchQuery, 'hours' | 'since' | 'until'>,
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

export function statsWindow(query: Pick<SearchQuery, 'hours' | 'since' | 'until'>, now: Date): { sinceMs: number; untilMs: number } {
  if (query.since?.trim() || query.hours != null) return searchWindow(query, now);
  return searchWindow({ ...query, hours: 24 }, now);
}

export function formatAppStats(
  rows: NotificationRow[],
  coverage: CoverageNote,
  sinceMs: number,
  untilMs: number
): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = (row.app_name || row.package_name || 'App').trim() || 'App';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const hours = Math.max(1, Math.round((untilMs - sinceMs) / 3_600_000));
  const lines = [
    formatCoverage(coverage),
    `Per-app counts for ${hours}h (${new Date(sinceMs).toISOString()} – ${new Date(untilMs).toISOString()}, ${rows.length} unique previews):`,
    ...ranked.map(([name, count]) => `${count} · ${redactSensitive(name)}`),
  ];
  if (!ranked.length) lines.push('No notifications in this window.');
  lines.push('Use these counts to pick app filters, then call search_notifications.');
  return lines.join('\n');
}

export function searchWindow(query: SearchQuery, now: Date): { sinceMs: number; untilMs: number } {
  const untilMs = parseBound(query.until, now.getTime());
  const hours =
    typeof query.hours === 'number' && Number.isFinite(query.hours)
      ? Math.min(168, Math.max(1, Math.round(query.hours)))
      : null;
  const defaultLookback = hours != null && !query.since?.trim() ? hours * 60 * 60_000 : DEFAULT_LOOKBACK_MS;
  const sinceMs = parseBound(query.since, untilMs - defaultLookback);
  return { sinceMs: Math.min(sinceMs, untilMs), untilMs };
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

function agoLabel(nowMs: number, thenMs: number): string {
  const mins = Math.max(0, Math.round((nowMs - thenMs) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function rowTimestampIso(row: { posted_at?: number | string | null; created_at?: number | string | null }): string | null {
  const posted = postedAtMs(row.posted_at);
  const created = postedAtMs(row.created_at);
  const best = Math.max(posted ?? 0, created ?? 0);
  return best > 0 ? new Date(best).toISOString() : null;
}

async function loadLatestNotificationAt(db: SupabaseClient, userId: string): Promise<string | null> {
  const byPosted = await db
    .from('notifications')
    .select('posted_at')
    .eq('user_id', userId)
    .order('posted_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (!byPosted.error && byPosted.data) {
    const iso = rowTimestampIso(byPosted.data as { posted_at?: number | string | null });
    if (iso) return iso;
  }
  if (byPosted.error && !/posted_at/i.test(byPosted.error.message)) {
    console.error('[notifications] latest row lookup failed', byPosted.error.message);
    return null;
  }
  const byCreated = await db
    .from('notifications')
    .select('created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (byCreated.error) {
    console.error('[notifications] latest row lookup failed', byCreated.error.message);
    return null;
  }
  if (!byCreated.data) return null;
  return rowTimestampIso(byCreated.data as { created_at?: number | string | null });
}

function newestPostedIso(rows: NotificationRow[]): string | null {
  let best: number | null = null;
  for (const row of rows) {
    const ms = postedAtMs(row.posted_at ?? row.created_at);
    if (ms == null) continue;
    if (best == null || ms > best) best = ms;
  }
  return best == null ? null : new Date(best).toISOString();
}

function newerIso(current: string | null, candidate: string | null): string | null {
  const candidateMs = candidate ? Date.parse(candidate) : NaN;
  if (!Number.isFinite(candidateMs)) return current;
  const currentMs = current ? Date.parse(current) : NaN;
  if (!Number.isFinite(currentMs) || candidateMs > currentMs) return new Date(candidateMs).toISOString();
  return current;
}

/**
 * The phone inserts notification rows directly. `device_tokens` is only the FCM
 * push target, so a quiet table is not evidence that a listener is down.
 */
function coverageNote(lastDataAt: string | null, now: Date, matchedRows: boolean): CoverageNote {
  const dataMs = lastDataAt ? Date.parse(lastDataAt) : NaN;
  const hasTime = Number.isFinite(dataMs);
  let text = 'Coverage: no stored notifications matched this query.';
  if (hasTime) text = `Coverage: newest stored notification ${agoLabel(now.getTime(), dataMs)}.`;
  else if (matchedRows) text = 'Coverage: stored notifications matched this query.';
  return {
    text,
    stale: false,
    lastDataAt: hasTime ? new Date(dataMs).toISOString() : null,
    lastDeviceSyncAt: null,
  };
}

async function loadCoverage(
  db: SupabaseClient,
  userId: string,
  now: Date,
  rows: NotificationRow[] = []
): Promise<CoverageNote> {
  const lookedUp = await loadLatestNotificationAt(db, userId);
  return coverageNote(newerIso(lookedUp, newestPostedIso(rows)), now, rows.length > 0);
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
      .limit(Math.min(MAX_FETCH, Math.max(limit, 40)))
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
      .limit(Math.min(MAX_FETCH, Math.max(limit, 40)))
      .abortSignal(controller.signal);
    if (created.error) throw new Error('Could not read notifications');
    return (created.data ?? []) as NotificationRow[];
  } finally {
    clearTimeout(timer);
  }
}

export function filterNotificationRows(
  rows: NotificationRow[],
  allowedApps: string[],
  query: SearchQuery
): NotificationRow[] {
  const appNeedle = query.app?.trim().toLowerCase();
  const excludeNeedle = query.exclude_app?.trim().toLowerCase();
  const senderNeedle = query.sender?.trim().toLowerCase();
  const textNeedle = query.text?.trim().toLowerCase();
  const categoryNeedle = query.category?.trim().toLowerCase();
  const seen = new Set<string>();
  const out: NotificationRow[] = [];
  for (const row of rows) {
    const app = (row.app_name || '').trim();
    const pkg = (row.package_name || '').trim();
    const appHay = `${app} ${pkg}`.toLowerCase();
    if (!appAllowed(app, pkg, allowedApps)) continue;
    if (appNeedle && !appHay.includes(appNeedle)) continue;
    if (excludeNeedle && appHay.includes(excludeNeedle)) continue;
    const title = (row.title || '').toLowerCase();
    const body = bodyOf(row).toLowerCase();
    const category = (row.category || '').toLowerCase();
    if (senderNeedle && !title.includes(senderNeedle)) continue;
    if (textNeedle && !`${title} ${body}`.includes(textNeedle)) continue;
    if (categoryNeedle && !category.includes(categoryNeedle)) continue;
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
      const { sinceMs, untilMs } = searchWindow(query, now);
      const limit = Math.min(MAX_SEARCH, Math.max(1, query.limit ?? DEFAULT_SEARCH));
      const offset = Math.max(0, query.offset ?? 0);
      const filtered = Boolean(query.app || query.exclude_app || query.sender || query.text || query.category);
      const fetchLimit = Math.min(MAX_FETCH, offset + limit + (filtered ? 200 : 20));
      const rows = filterNotificationRows(await fetchWindow(db, userId, sinceMs, untilMs, fetchLimit), allowedApps, query);
      const page = rows.slice(offset, offset + limit);
      const items = page.map(toItem).filter((item): item is NotificationItem => item != null);
      const coverage = await loadCoverage(db, userId, now, rows);
      const nextOffset = offset + limit < rows.length ? offset + limit : null;
      return { items, coverage, nextOffset };
    },

    async appStats(userId, allowedApps, query, now) {
      const { sinceMs, untilMs } = statsWindow(query, now);
      const rows = filterNotificationRows(
        await fetchWindow(db, userId, sinceMs, untilMs, MAX_FETCH),
        allowedApps,
        {}
      );
      const coverage = await loadCoverage(db, userId, now, rows);
      return { text: formatAppStats(rows, coverage, sinceMs, untilMs), coverage };
    },

    async digest(userId, allowedApps, since, groupBy, now) {
      const sinceMs = parseBound(since, now.getTime() - 24 * 60 * 60_000);
      const rows = filterNotificationRows(await fetchWindow(db, userId, sinceMs, now.getTime(), 80), allowedApps, {});
      const counts = new Map<string, number>();
      for (const row of rows) {
        const key =
          groupBy === 'app'
            ? (row.app_name || row.package_name || 'App').trim()
            : (row.title || '(unknown)').trim().slice(0, 80);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
      const coverage = await loadCoverage(db, userId, now, rows);
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
      if (!Number.isInteger(numeric)) return { item: null, body: '', coverage: await loadCoverage(db, userId, now) };
      const { data, error } = await db
        .from('notifications')
        .select('id, app_name, package_name, title, text, sub_text, big_text, category, posted_at')
        .eq('user_id', userId)
        .eq('id', numeric)
        .maybeSingle();
      if (error) throw new Error('Could not read notification');
      if (!data) return { item: null, body: '', coverage: await loadCoverage(db, userId, now) };
      const row = data as NotificationRow;
      const coverage = await loadCoverage(db, userId, now, [row]);
      if (!appAllowed(row.app_name || '', row.package_name || '', allowedApps)) {
        return { item: null, body: '', coverage };
      }
      const item = toItem(row);
      const body = redactSensitive(bodyOf(row)).slice(0, MAX_BODY);
      return { item, body, coverage };
    },

    async listApps(userId, allowedApps, now) {
      const sinceMs = now.getTime() - 7 * 24 * 60 * 60_000;
      const rows = filterNotificationRows(await fetchWindow(db, userId, sinceMs, now.getTime(), 100), allowedApps, {});
      const apps = [...new Set(rows.map((row) => (row.app_name || row.package_name || 'App').trim()))].sort();
      const coverage = await loadCoverage(db, userId, now, rows);
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
