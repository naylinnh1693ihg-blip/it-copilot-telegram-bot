import { AsyncLocalStorage } from "node:async_hooks";
import { autoRetry } from "@grammyjs/auto-retry";
import type { Transformer } from "grammy";

/**
 * Telegram 429 handling for every Bot API call (replies, reminder sends, button edits).
 *
 * - A short retry_after (up to MAX_DELAY_SECONDS) is waited out and the call is retried.
 * - A longer one is rethrown, so callers see the failure. The reminder worker then records
 *   a failed attempt and uses its own backoff. It never reports the reminder as sent.
 * - Network errors (HttpError) are rethrown, not retried. The plugin retries them without
 *   limit (maxRetryAttempts does not cover them), and a send that may already have reached
 *   Telegram could be delivered twice.
 */
export const AUTO_RETRY_OPTIONS = {
  maxRetryAttempts: 3,
  maxDelaySeconds: 10,
  rethrowInternalServerErrors: false,
  rethrowHttpErrors: true,
} as const;

const bypass = new AsyncLocalStorage<true>();

/**
 * Runs `task` with auto-retry turned off for the Bot API calls it makes. Streaming previews
 * use this: createThrottledEdit handles 429 itself by skipping stale previews, so waiting
 * seconds to deliver an out-of-date preview would only delay the real answer.
 */
export function withoutAutoRetry<T>(task: () => Promise<T>): Promise<T> {
  return bypass.run(true, task);
}

export function telegramRetry(options: Partial<typeof AUTO_RETRY_OPTIONS> = {}): Transformer {
  const retry = autoRetry({ ...AUTO_RETRY_OPTIONS, ...options });
  return (prev, method, payload, signal) =>
    bypass.getStore() ? prev(method, payload, signal) : retry(prev, method, payload, signal);
}
