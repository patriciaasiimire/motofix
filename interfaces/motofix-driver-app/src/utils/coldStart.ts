// utils/coldStart.ts — decides when a failed request should be retried because the
// server is probably just waking up.
//
// Render's free tier puts a service to sleep after ~15 minutes without traffic, and the
// first request after that can take up to about a minute. While it wakes, Render's proxy
// answers quickly with no CORS headers (the browser reports that as a plain "network
// error") or with a 502/503/504. So waiting only a few seconds before giving up is too
// short: this file spreads the retries over roughly a minute and a half instead.
//
// No imports on purpose: it is plain logic, so it can be tested without the app.

/** Waits between retries for requests that are safe to repeat (~57s of waiting). */
export const WAKE_RETRY_DELAYS_MS = [2_000, 4_000, 6_000, 8_000, 10_000, 12_000, 15_000] as const;

/** Waits for requests that must NOT be repeated many times (e.g. creating a job). */
export const SHORT_RETRY_DELAYS_MS = [3_000, 8_000] as const;

/** Never keep retrying one request for longer than this (milliseconds). */
export const WAKE_MAX_TOTAL_MS = 100_000;

/** POSTs that are safe to repeat: the server re-sends the same code to the same number. */
const SAFE_TO_REPEAT_POSTS = new Set(['/auth/register/driver', '/auth/resend-otp']);

export interface RetryInput {
  method?: string;
  url?: string;
  /** How many retries have already happened (0 = this was the first failure). */
  attempt: number;
  /** Milliseconds since the first attempt of this request started. */
  elapsedMs: number;
  /** Did the server (or its proxy) send any HTTP response at all? */
  hasResponse: boolean;
  status?: number;
  /** axios error code, e.g. 'ERR_NETWORK', 'ECONNABORTED', 'ERR_CANCELED'. */
  code?: string;
  /** Optional "try again in N seconds" hint sent by our own services (503 responses). */
  retryAfterSeconds?: number;
}

/** True when the failure looks like a sleeping or restarting server. */
export function isWakeFailure(input: Pick<RetryInput, 'hasResponse' | 'status' | 'code'>): boolean {
  if (!input.hasResponse) return input.code !== 'ERR_CANCELED';
  return input.status === 502 || input.status === 503 || input.status === 504;
}

function normalizePath(url?: string): string {
  const path = (url ?? '').split('?')[0].replace(/\/+$/, '');
  return path.startsWith('/') ? path : `/${path}`;
}

function scheduleFor(method: string, url?: string): readonly number[] {
  if (method === 'get' || method === 'head') return WAKE_RETRY_DELAYS_MS;
  if (method === 'post' && SAFE_TO_REPEAT_POSTS.has(normalizePath(url))) return WAKE_RETRY_DELAYS_MS;
  return SHORT_RETRY_DELAYS_MS;
}

/**
 * How long to wait before retrying, in milliseconds, or null to stop and show the error.
 */
export function getWakeRetryDelayMs(input: RetryInput): number | null {
  if (!isWakeFailure(input)) return null;

  const schedule = scheduleFor((input.method ?? 'get').toLowerCase(), input.url);
  if (input.attempt >= schedule.length) return null;

  let delay = schedule[input.attempt];
  if (typeof input.retryAfterSeconds === 'number' && input.retryAfterSeconds > 0) {
    // Respect the server's hint, but never wait more than 15s between tries.
    delay = Math.max(delay, Math.min(input.retryAfterSeconds * 1_000, 15_000));
  }

  if (input.elapsedMs + delay > WAKE_MAX_TOTAL_MS) return null;
  return delay;
}
