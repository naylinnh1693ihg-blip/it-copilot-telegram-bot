import { ClaudeError, GenerationStoppedError, isBillingError, LlmError } from "../../utils/errors.js";
import type { AppLogger } from "../../utils/logger.js";
import { toIso, type Clock } from "../../utils/time.js";
import { currentAbortSignal } from "../grok/abort.js";
import type { LlmClient, LlmProviderState } from "../grok/client.js";

/**
 * Decides which provider answers. Grok is primary; Claude is the backup only.
 *
 * Falls back on: 429, billing/credit errors (402, or 403 about credits), 5xx after Grok's own retry,
 * and timeouts or connection failures. Never on a 400, a refusal, or a stop.
 * After a fallback, every call goes straight to Claude for cooldownMs (or Grok's longer retry-after),
 * then Grok is tried again. embed always goes to Grok: Claude has no embeddings.
 */

export type FallbackReason = "rate_limited" | "billing" | "server_error" | "unreachable";

/** The fallback client always streams and always reports its state. */
export type FallbackClient = LlmClient & {
  state(): LlmProviderState;
  streamText: NonNullable<LlmClient["streamText"]>;
  streamStructured: NonNullable<LlmClient["streamStructured"]>;
};

export function fallbackReason(error: unknown): FallbackReason | null {
  if (error instanceof GenerationStoppedError) return null;
  if (!(error instanceof LlmError)) return null;
  if (error.kind === "refusal" || error.status === 400) return null;
  if (error.status === 429) return "rate_limited";
  if (isBillingError(error)) return "billing";
  if (error.status >= 500) return "server_error";
  if (error.kind === "transport" || error.status === 408) return "unreachable";
  return null;
}

type Provider = "grok" | "claude";

export function createFallbackClient(options: {
  primary: LlmClient;
  backup: LlmClient;
  logger: AppLogger;
  clock: Clock;
  cooldownMs: number;
}): FallbackClient {
  const { primary, backup, logger, clock } = options;
  const from: Provider = "grok";
  const to: Provider = "claude";
  let until = 0;
  let reason: FallbackReason | undefined;

  const nowMs = () => clock.now().toMillis();

  function backupActive(): boolean {
    if (until === 0) return false;
    if (nowMs() < until) return true;
    until = 0;
    reason = undefined;
    logger.info({ event: "llm_fallback", from: to, to: from, reason: "cooldown_over" }, "trying the primary AI provider again");
    return false;
  }

  function switchToBackup(why: FallbackReason, error: unknown): void {
    const retryAfter = error instanceof LlmError ? error.retryAfterMs ?? 0 : 0;
    const wasActive = until > nowMs();
    until = Math.max(until, nowMs() + Math.max(options.cooldownMs, retryAfter));
    reason = why;
    if (!wasActive) {
      const status = error instanceof LlmError ? error.status : 0;
      logger.warn({ event: "llm_fallback", from, to, reason: why, status }, "switching to the backup AI provider");
    }
  }

  /** The backup failed after the primary did. Mark it so the reply says both failed. */
  function backupFailed(error: unknown): never {
    if (error instanceof ClaudeError && error.kind !== "refusal" && !error.afterFallback) {
      throw new ClaudeError(error.message, error.retryable, error.status, {
        kind: error.kind,
        retryAfterMs: error.retryAfterMs,
        afterFallback: true,
      });
    }
    throw error;
  }

  async function route<T>(
    signal: AbortSignal | undefined,
    callPrimary: () => Promise<T>,
    callBackup: () => Promise<T>,
    mayFallBack: () => boolean = () => true,
  ): Promise<T> {
    if (backupActive()) return callBackup().catch(backupFailed);
    try {
      return await callPrimary();
    } catch (error) {
      if (signal?.aborted) throw error instanceof GenerationStoppedError ? error : new GenerationStoppedError();
      const why = fallbackReason(error);
      if (!why || !mayFallBack()) throw error;
      switchToBackup(why, error);
      try {
        return await callBackup();
      } catch (backupError) {
        return backupFailed(backupError);
      }
    }
  }

  const client: FallbackClient = {
    completeStructured(input) {
      const signal = input.signal ?? currentAbortSignal();
      return route(signal, () => primary.completeStructured(input), () => backup.completeStructured(input));
    },
    completeText(input) {
      const signal = input.signal ?? currentAbortSignal();
      return route(signal, () => primary.completeText(input), () => backup.completeText(input));
    },
    streamText(input) {
      const signal = input.signal ?? currentAbortSignal();
      // Fall back only if nothing reached the user yet. Two models' text must not be mixed in one reply.
      let shown = false;
      const onDelta = input.onDelta
        ? async (snapshot: string) => {
            shown = true;
            await input.onDelta?.(snapshot);
          }
        : undefined;
      return route(
        signal,
        () => (primary.streamText ? primary.streamText({ ...input, onDelta }) : primary.completeText(input)),
        () => (backup.streamText ? backup.streamText(input) : backup.completeText(input)),
        () => !shown,
      );
    },
    streamStructured(input) {
      const signal = input.signal ?? currentAbortSignal();
      let shown = false;
      const onDelta = input.onDelta
        ? async (snapshot: string) => {
            shown = true;
            await input.onDelta?.(snapshot);
          }
        : undefined;
      return route(
        signal,
        () => (primary.streamStructured ? primary.streamStructured({ ...input, onDelta }) : primary.completeStructured(input)),
        () => (backup.streamStructured ? backup.streamStructured(input) : backup.completeStructured(input)),
        () => !shown,
      );
    },
    state() {
      if (backupActive()) return { active: to, until: toIso(clock.now().plus({ milliseconds: until - nowMs() })), reason };
      return { active: from };
    },
  };

  if (primary.completeWithTools) {
    const primaryTools = primary.completeWithTools.bind(primary);
    const backupTools = backup.completeWithTools?.bind(backup);
    client.completeWithTools = (input) => {
      const signal = input.signal ?? currentAbortSignal();
      if (!backupTools) return primaryTools(input);
      return route(signal, () => primaryTools(input), () => backupTools(input));
    };
  }
  if (primary.embed) {
    const embed = primary.embed.bind(primary);
    client.embed = (input) => embed(input);
  }
  return client;
}

/**
 * The client deps.llm uses. Both keys: Grok with the Claude backup. Grok only: the plain Grok client,
 * exactly as before. Claude only: Claude alone, so embeddings are off and RAG uses lexical search.
 */
export function selectLlmClient(options: {
  grok: LlmClient | null;
  claude: LlmClient | null;
  logger: AppLogger;
  clock: Clock;
  cooldownMs: number;
}): LlmClient | null {
  if (options.grok && options.claude) {
    return createFallbackClient({
      primary: options.grok,
      backup: options.claude,
      logger: options.logger,
      clock: options.clock,
      cooldownMs: options.cooldownMs,
    });
  }
  return options.grok ?? options.claude ?? null;
}
