import { AsyncLocalStorage } from "node:async_hooks";

const ambient = new AsyncLocalStorage<AbortSignal>();

/**
 * Runs `task` with `signal` as the stop signal for every Grok call it makes, however deep.
 * deliver() uses this so the Telegram Stop button can cancel the request in flight
 * without threading a signal through every service function.
 */
export function withAbortSignal<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
  return ambient.run(signal, task);
}

/** The stop signal for the reply being produced, if any. */
export function currentAbortSignal(): AbortSignal | undefined {
  return ambient.getStore();
}
