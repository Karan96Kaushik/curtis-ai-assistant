import { callFunction } from './client';
import type { PushPayloadInput } from '../push/payload';

export type SendPushRequest = PushPayloadInput;

export interface SendPushResponse {
  sent: number;
  failed: number;
  removed: number;
  message?: string;
}

/** Send an FCM push to every device token registered for the signed-in user. */
export function sendPushNotification(
  request: SendPushRequest,
  signal?: AbortSignal
): Promise<SendPushResponse> {
  return callFunction<SendPushResponse>('sendPush', request, { signal });
}
