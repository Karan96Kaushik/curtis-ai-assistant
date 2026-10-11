import { json, parseBody, withHttp } from '../_shared/http.js';
import { sendPushToUser } from '../_shared/fcm.js';
import type { PushPayloadInput } from '../../../lib/push/payload.js';
import { requireAllowedCaller } from '../_shared/verifySupabaseAuth.js';

export const handler = withHttp('sendPush', async (event) => {
  const caller = await requireAllowedCaller(event);
  const body = parseBody<PushPayloadInput>(event);

  const result = await sendPushToUser(caller.userId, body);

  if (result.sent === 0 && result.failed === 0) {
    return json(200, { ...result, message: 'No device tokens registered for this account' });
  }
  return json(200, result);
});
