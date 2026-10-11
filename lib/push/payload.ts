/**
 * Shared outbound push shape for agent + FCM + Android app.
 * Rich fields travel in FCM `data` (string map); a few also map to android.notification.
 * See context/android-push-notifications-spec.md for the receive/execute contract.
 */

export const PUSH_ACTION_IDS = ['open', 'snooze', 'mark_done', 'open_draft', 'view_issue'] as const;
export type PushActionId = (typeof PUSH_ACTION_IDS)[number];

export const PUSH_CHANNELS = ['urgent', 'default', 'digest', 'progress', 'quiet'] as const;
export type PushChannel = (typeof PUSH_CHANNELS)[number];

export const PUSH_CATEGORIES = [
  'msg',
  'email',
  'reminder',
  'progress',
  'recommendation',
  'status',
  'promo',
] as const;
export type PushCategory = (typeof PUSH_CATEGORIES)[number];

export const PUSH_URGENCIES = ['low', 'normal', 'high'] as const;
export type PushUrgency = (typeof PUSH_URGENCIES)[number];

export const PUSH_STYLES = ['default', 'big_text', 'big_picture', 'progress'] as const;
export type PushStyle = (typeof PUSH_STYLES)[number];

export interface PushAction {
  id: PushActionId;
  label: string;
}

export interface PushProgress {
  current: number;
  max: number;
  indeterminate?: boolean;
}

/** Agent / API input before normalization. */
export interface PushPayloadInput {
  title: string;
  body: string;
  subtitle?: string;
  expanded_body?: string;
  category?: PushCategory;
  channel?: PushChannel;
  urgency?: PushUrgency;
  silent?: boolean;
  notification_key?: string;
  group_key?: string;
  deep_link?: string;
  image_url?: string;
  large_icon_url?: string;
  related_notification_id?: string;
  when?: string;
  expires_at?: string;
  only_alert_once?: boolean;
  style?: PushStyle;
  progress?: PushProgress;
  short_critical_text?: string;
  ongoing?: boolean;
  request_promoted?: boolean;
  actions?: PushAction[];
  /** Extra string map merged into FCM data (app-reserved keys win). */
  data?: Record<string, string>;
}

export interface NormalizedPushPayload {
  title: string;
  body: string;
  subtitle?: string;
  expandedBody?: string;
  category?: PushCategory;
  channel: PushChannel;
  urgency: PushUrgency;
  silent: boolean;
  notificationKey?: string;
  groupKey?: string;
  deepLink?: string;
  imageUrl?: string;
  largeIconUrl?: string;
  relatedNotificationId?: string;
  when?: string;
  expiresAt?: string;
  onlyAlertOnce: boolean;
  style: PushStyle;
  progress?: PushProgress;
  shortCriticalText?: string;
  ongoing: boolean;
  requestPromoted: boolean;
  actions: PushAction[];
  extraData: Record<string, string>;
}

export interface FcmAndroidNotification {
  title: string;
  body: string;
  channel_id: string;
  tag?: string;
  image?: string;
  click_action?: string;
  notification_priority?: 'PRIORITY_MIN' | 'PRIORITY_LOW' | 'PRIORITY_DEFAULT' | 'PRIORITY_HIGH' | 'PRIORITY_MAX';
  visibility?: 'PRIVATE' | 'PUBLIC' | 'SECRET';
  sticky?: boolean;
  event_time?: string;
  ticker?: string;
  default_sound?: boolean;
  default_vibrate_timings?: boolean;
}

export interface FcmMessageParts {
  notification: { title: string; body: string };
  data: Record<string, string>;
  android: {
    priority: 'HIGH' | 'NORMAL';
    collapse_key?: string;
    notification: FcmAndroidNotification;
  };
}

export const MAX_TITLE_CHARS = 120;
export const MAX_BODY_CHARS = 1000;
export const MAX_SUBTITLE_CHARS = 120;
export const MAX_EXPANDED_BODY_CHARS = 2000;
export const MAX_KEY_CHARS = 80;
export const MAX_URL_CHARS = 500;
export const MAX_DEEP_LINK_CHARS = 500;
export const MAX_ACTION_LABEL_CHARS = 40;
export const MAX_ACTIONS = 3;
export const MAX_SHORT_CRITICAL_CHARS = 8;
export const MAX_DATA_KEYS = 20;
export const MAX_DATA_KEY_CHARS = 80;
export const MAX_DATA_VALUE_CHARS = 500;

/** Android NotificationChannel ids the app must create. */
export const CHANNEL_IDS: Record<PushChannel, string> = {
  urgent: 'curtis_urgent',
  default: 'curtis_default',
  digest: 'curtis_digest',
  progress: 'curtis_progress',
  quiet: 'curtis_quiet',
};

const ACTION_ID_SET = new Set<string>(PUSH_ACTION_IDS);
const CHANNEL_SET = new Set<string>(PUSH_CHANNELS);
const CATEGORY_SET = new Set<string>(PUSH_CATEGORIES);
const URGENCY_SET = new Set<string>(PUSH_URGENCIES);
const STYLE_SET = new Set<string>(PUSH_STYLES);

export class PushPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushPayloadError';
  }
}

function trimSpace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function asOptionalString(raw: unknown, field: string, max: number): string | undefined {
  if (raw == null || raw === '') return undefined;
  if (typeof raw !== 'string') throw new PushPayloadError(`${field} must be a string`);
  const text = trimSpace(raw);
  if (!text) return undefined;
  if (text.length > max) throw new PushPayloadError(`${field} must be at most ${max} characters`);
  return text;
}

function asBoolean(raw: unknown, field: string): boolean | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== 'boolean') throw new PushPayloadError(`${field} must be a boolean`);
  return raw;
}

function httpsUrl(raw: unknown, field: string): string | undefined {
  const text = asOptionalString(raw, field, MAX_URL_CHARS);
  if (!text) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new PushPayloadError(`${field} must be a valid URL`);
  }
  if (url.protocol !== 'https:') throw new PushPayloadError(`${field} must be an https URL`);
  return text;
}

function parseEnum<T extends string>(raw: unknown, field: string, allowed: Set<string>): T | undefined {
  if (raw == null || raw === '') return undefined;
  if (typeof raw !== 'string' || !allowed.has(raw)) {
    throw new PushPayloadError(`${field} must be one of: ${[...allowed].join(', ')}`);
  }
  return raw as T;
}

function parseProgress(raw: unknown): PushProgress | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PushPayloadError('progress must be an object');
  }
  const body = raw as Record<string, unknown>;
  const current = body.current;
  const max = body.max;
  if (typeof current !== 'number' || !Number.isInteger(current) || current < 0 || current > 10_000) {
    throw new PushPayloadError('progress.current must be an integer 0–10000');
  }
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 10_000) {
    throw new PushPayloadError('progress.max must be an integer 1–10000');
  }
  if (current > max) throw new PushPayloadError('progress.current cannot exceed progress.max');
  const indeterminate = asBoolean(body.indeterminate, 'progress.indeterminate');
  return { current, max, ...(indeterminate != null ? { indeterminate } : {}) };
}

function parseActions(raw: unknown): PushAction[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new PushPayloadError('actions must be an array');
  if (raw.length > MAX_ACTIONS) throw new PushPayloadError(`actions can include at most ${MAX_ACTIONS} items`);
  const out: PushAction[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new PushPayloadError('each action must be an object');
    }
    const row = item as Record<string, unknown>;
    const id = parseEnum<PushActionId>(row.id, 'actions[].id', ACTION_ID_SET);
    if (!id) throw new PushPayloadError('actions[].id is required');
    const label = asOptionalString(row.label, 'actions[].label', MAX_ACTION_LABEL_CHARS);
    if (!label) throw new PushPayloadError('actions[].label is required');
    out.push({ id, label });
  }
  return out;
}

function parseExtraData(raw: unknown): Record<string, string> {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PushPayloadError('data must be an object of string values');
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_DATA_KEYS) {
    throw new PushPayloadError(`data can include at most ${MAX_DATA_KEYS} keys`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (key.length > MAX_DATA_KEY_CHARS) {
      throw new PushPayloadError(`data key "${key.slice(0, 40)}…" is too long`);
    }
    if (key.startsWith('curtis_')) {
      throw new PushPayloadError(`data key "${key}" is reserved`);
    }
    if (value == null) continue;
    const str = String(value);
    if (str.length > MAX_DATA_VALUE_CHARS) {
      throw new PushPayloadError(`data value for "${key}" is too long`);
    }
    out[key] = str;
  }
  return out;
}

/**
 * Normalize and validate agent/API push input.
 */
export function normalizePushPayload(raw: unknown): NormalizedPushPayload {
  const body =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const title = asOptionalString(body.title, 'title', MAX_TITLE_CHARS);
  const text = asOptionalString(body.body, 'body', MAX_BODY_CHARS);
  if (!title) throw new PushPayloadError('title is required');
  if (!text) throw new PushPayloadError('body is required');

  const style = parseEnum<PushStyle>(body.style, 'style', STYLE_SET) ?? 'default';
  const progress = parseProgress(body.progress);
  if (style === 'progress' && !progress && body.progress == null) {
    throw new PushPayloadError('progress is required when style is progress');
  }
  if (style === 'big_picture') {
    const image = httpsUrl(body.image_url, 'image_url');
    if (!image) throw new PushPayloadError('image_url is required when style is big_picture');
  }

  const channel = parseEnum<PushChannel>(body.channel, 'channel', CHANNEL_SET);
  const urgency = parseEnum<PushUrgency>(body.urgency, 'urgency', URGENCY_SET) ?? 'normal';
  const silent = asBoolean(body.silent, 'silent') ?? false;
  const ongoing = asBoolean(body.ongoing, 'ongoing') ?? style === 'progress';
  const requestPromoted = asBoolean(body.request_promoted, 'request_promoted') ?? false;
  if (requestPromoted && !ongoing) {
    throw new PushPayloadError('request_promoted requires ongoing: true');
  }

  let resolvedChannel: PushChannel = channel ?? 'default';
  if (!channel) {
    if (style === 'progress' || ongoing) resolvedChannel = 'progress';
    else if (silent || urgency === 'low') resolvedChannel = 'quiet';
    else if (urgency === 'high') resolvedChannel = 'urgent';
  }

  return {
    title,
    body: text,
    subtitle: asOptionalString(body.subtitle, 'subtitle', MAX_SUBTITLE_CHARS),
    expandedBody: asOptionalString(body.expanded_body, 'expanded_body', MAX_EXPANDED_BODY_CHARS),
    category: parseEnum<PushCategory>(body.category, 'category', CATEGORY_SET),
    channel: resolvedChannel,
    urgency,
    silent,
    notificationKey: asOptionalString(body.notification_key, 'notification_key', MAX_KEY_CHARS),
    groupKey: asOptionalString(body.group_key, 'group_key', MAX_KEY_CHARS),
    deepLink: asOptionalString(body.deep_link, 'deep_link', MAX_DEEP_LINK_CHARS),
    imageUrl: httpsUrl(body.image_url, 'image_url'),
    largeIconUrl: httpsUrl(body.large_icon_url, 'large_icon_url'),
    relatedNotificationId: asOptionalString(
      body.related_notification_id,
      'related_notification_id',
      40
    ),
    when: asOptionalString(body.when, 'when', 40),
    expiresAt: asOptionalString(body.expires_at, 'expires_at', 40),
    onlyAlertOnce: asBoolean(body.only_alert_once, 'only_alert_once') ?? Boolean(body.notification_key),
    style,
    progress,
    shortCriticalText: asOptionalString(
      body.short_critical_text,
      'short_critical_text',
      MAX_SHORT_CRITICAL_CHARS
    ),
    ongoing,
    requestPromoted,
    actions: parseActions(body.actions),
    extraData: parseExtraData(body.data),
  };
}

function urgencyToPriority(
  urgency: PushUrgency,
  silent: boolean
): FcmAndroidNotification['notification_priority'] {
  if (silent || urgency === 'low') return 'PRIORITY_LOW';
  if (urgency === 'high') return 'PRIORITY_HIGH';
  return 'PRIORITY_DEFAULT';
}

/**
 * Build FCM v1 message parts. App reads `data` for rich rendering; notification is the fallback.
 */
export function buildFcmMessageParts(payload: NormalizedPushPayload): FcmMessageParts {
  const channelId = CHANNEL_IDS[payload.channel];
  const data: Record<string, string> = {
    curtis_v: '1',
    curtis_title: payload.title,
    curtis_body: payload.body,
    curtis_channel: payload.channel,
    curtis_channel_id: channelId,
    curtis_urgency: payload.urgency,
    curtis_silent: payload.silent ? '1' : '0',
    curtis_style: payload.style,
    curtis_only_alert_once: payload.onlyAlertOnce ? '1' : '0',
    curtis_ongoing: payload.ongoing ? '1' : '0',
    curtis_request_promoted: payload.requestPromoted ? '1' : '0',
  };

  if (payload.subtitle) data.curtis_subtitle = payload.subtitle;
  if (payload.expandedBody) data.curtis_expanded_body = payload.expandedBody;
  if (payload.category) data.curtis_category = payload.category;
  if (payload.notificationKey) data.curtis_notification_key = payload.notificationKey;
  if (payload.groupKey) data.curtis_group_key = payload.groupKey;
  if (payload.deepLink) data.curtis_deep_link = payload.deepLink;
  if (payload.imageUrl) data.curtis_image_url = payload.imageUrl;
  if (payload.largeIconUrl) data.curtis_large_icon_url = payload.largeIconUrl;
  if (payload.relatedNotificationId) {
    data.curtis_related_notification_id = payload.relatedNotificationId;
  }
  if (payload.when) data.curtis_when = payload.when;
  if (payload.expiresAt) data.curtis_expires_at = payload.expiresAt;
  if (payload.shortCriticalText) data.curtis_short_critical_text = payload.shortCriticalText;
  if (payload.progress) {
    data.curtis_progress_current = String(payload.progress.current);
    data.curtis_progress_max = String(payload.progress.max);
    if (payload.progress.indeterminate) data.curtis_progress_indeterminate = '1';
  }
  if (payload.actions.length) {
    data.curtis_actions = JSON.stringify(payload.actions);
  }

  for (const [key, value] of Object.entries(payload.extraData)) {
    data[key] = value;
  }

  const androidNotification: FcmAndroidNotification = {
    title: payload.title,
    body: payload.body,
    channel_id: channelId,
    notification_priority: urgencyToPriority(payload.urgency, payload.silent),
    visibility: 'PRIVATE',
    default_sound: !payload.silent,
    default_vibrate_timings: !payload.silent && payload.urgency === 'high',
  };
  if (payload.notificationKey) androidNotification.tag = payload.notificationKey;
  if (payload.imageUrl) androidNotification.image = payload.imageUrl;
  if (payload.deepLink) androidNotification.click_action = 'CURTIS_OPEN';
  if (payload.ongoing) androidNotification.sticky = true;
  if (payload.when) {
    try {
      androidNotification.event_time = new Date(payload.when).toISOString();
    } catch {
      // leave unset
    }
  }
  if (payload.subtitle) androidNotification.ticker = payload.subtitle;

  return {
    notification: { title: payload.title, body: payload.body },
    data,
    android: {
      priority: payload.silent || payload.urgency === 'low' ? 'NORMAL' : 'HIGH',
      ...(payload.notificationKey ? { collapse_key: payload.notificationKey.slice(0, 64) } : {}),
      notification: androidNotification,
    },
  };
}

/** Convenience: normalize unknown input then build FCM parts. */
export function preparePushMessage(raw: unknown): {
  payload: NormalizedPushPayload;
  fcm: FcmMessageParts;
} {
  const payload = normalizePushPayload(raw);
  return { payload, fcm: buildFcmMessageParts(payload) };
}
