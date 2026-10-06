import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { startRequestTimer } from './timing.js';

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export type HttpEvent = LambdaFunctionURLEvent;
export type HttpResult = LambdaFunctionURLResult & { statusCode: number };

export function json(status: number, body: unknown): HttpResult {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function parseBody<T extends object>(event: HttpEvent): Partial<T> {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Request body must be JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return parsed as Partial<T>;
}

/**
 * POST-only Function URL handler: translates HttpError to `{ error }` JSON,
 * hides unexpected errors behind a 500, and logs request timing.
 */
export function withHttp(name: string, fn: (event: HttpEvent) => Promise<HttpResult>) {
  return async (event: HttpEvent): Promise<HttpResult> => {
    const timer = startRequestTimer(name);
    const method = event.requestContext?.http?.method ?? 'POST';
    if (method !== 'POST') {
      timer.end(405);
      return json(405, { error: 'Method not allowed' });
    }
    try {
      const result = await fn(event);
      timer.end(result.statusCode);
      return result;
    } catch (err) {
      if (err instanceof HttpError) {
        timer.end(err.status);
        return json(err.status, { error: err.message });
      }
      console.error(`[${name}] unhandled error`, err);
      timer.end(500);
      return json(500, { error: 'Internal error' });
    }
  };
}
