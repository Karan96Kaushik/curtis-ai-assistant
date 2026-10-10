import { callFunction } from './client';

export interface SendPushRequest {
  title: string;
  body: string;
  data?: Record<string, string>;
}

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
