import { HttpError, json, parseBody, withHttp } from '../_shared/http.js';
import { sendPushToUser } from '../_shared/fcm.js';
import { requireAllowedCaller } from '../_shared/verifySupabaseAuth.js';

interface SendPushRequest {
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
}

function stringData(raw: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.length > 80) continue;
    if (value == null) continue;
    const text = String(value);
    if (text.length > 500) continue;
    out[key] = text;
  }
  return Object.keys(out).length ? out : undefined;
}

export const handler = withHttp('sendPush', async (event) => {
  const caller = await requireAllowedCaller(event);
  const body = parseBody<SendPushRequest>(event);
  const title = typeof body.title === 'string' ? body.title : '';
  const text = typeof body.body === 'string' ? body.body : '';
  if (!title.trim() || !text.trim()) {
    throw new HttpError(400, 'title and body are required');
  }

  const result = await sendPushToUser(caller.userId, {
    title,
    body: text,
    data: stringData(body.data),
  });

  if (result.sent === 0 && result.failed === 0) {
    return json(200, { ...result, message: 'No device tokens registered for this account' });
  }
  return json(200, result);
});
