export class AppError extends Error {
  constructor(public readonly userMessage: string) {
    super(userMessage);
    this.name = "AppError";
  }
}

export class DatabaseError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = "DatabaseError";
  }
}

/** A form field failed a check that needs saved records, such as a conflicting IP. */
export class FormFieldError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "FormFieldError";
  }
}

/** A unique index rejected the row. `field` is the form field that should show `message`. */
export class DuplicateFieldError extends FormFieldError {
  constructor(field: string, message: string) {
    super(field, message);
    this.name = "DuplicateFieldError";
  }
}

export type LlmProvider = "grok" | "claude";

/**
 * status: the API answered with an HTTP error. transport: no answer (connection failure or timeout).
 * output: the model answered but the reply was unusable (empty, invalid JSON). refusal: the model declined.
 */
export type LlmErrorKind = "status" | "transport" | "output" | "refusal";

export interface LlmErrorOptions {
  kind?: LlmErrorKind;
  /** How long the provider asked us to wait (retry-after), in milliseconds. */
  retryAfterMs?: number;
  /** True when the primary provider had already failed and this is the backup's error. */
  afterFallback?: boolean;
}

/** A failed model call. Messages never contain prompts or API keys. */
export class LlmError extends Error {
  public readonly kind: LlmErrorKind;
  public readonly retryAfterMs?: number;
  public readonly afterFallback: boolean;

  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status = 0,
    public readonly provider: LlmProvider = "grok",
    options: LlmErrorOptions = {},
  ) {
    super(message);
    this.name = "LlmError";
    this.kind = options.kind ?? (status > 0 ? "status" : "output");
    this.retryAfterMs = options.retryAfterMs;
    this.afterFallback = options.afterFallback ?? false;
  }
}

export class GrokError extends LlmError {
  constructor(message: string, retryable: boolean, status = 0, options: LlmErrorOptions = {}) {
    super(message, retryable, status, "grok", options);
    this.name = "GrokError";
  }
}

export class ClaudeError extends LlmError {
  constructor(message: string, retryable: boolean, status = 0, options: LlmErrorOptions = {}) {
    super(message, retryable, status, "claude", options);
    this.name = "ClaudeError";
  }
}

const BILLING_WORDS = /\b(credit|credits|billing|spending|spend limit|quota|subscription|balance|payment)\b/i;

/**
 * 402, or a 403 whose message is about credits or billing. A plain 403 (bad key, no model access) is not billing.
 * Anthropic reports an empty credit balance as a 400 whose message says so, so that counts for Claude too.
 */
export function isBillingError(error: unknown): boolean {
  if (!(error instanceof LlmError)) return false;
  if (error.status === 402) return true;
  if (error.status === 403) return BILLING_WORDS.test(error.message);
  return error.status === 400 && error.provider === "claude" && BILLING_WORDS.test(error.message);
}

/** Reads retry-after-ms or retry-after (seconds or an HTTP date) from SDK error headers. */
export function retryAfterFromHeaders(headers: unknown, nowMs = Date.now()): number | undefined {
  const read = (name: string): string | null => {
    if (!headers || typeof headers !== "object") return null;
    if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name);
    const value = (headers as Record<string, unknown>)[name];
    return typeof value === "string" ? value : null;
  };
  const ms = Number(read("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const raw = read("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) && at > nowMs ? at - nowMs : undefined;
}

/** The user pressed Stop. Not a failure: it is never retried, logged as an error, or recorded as a failed call. */
export class GenerationStoppedError extends Error {
  constructor() {
    super("Generation stopped by the user.");
    this.name = "GenerationStoppedError";
  }
}

export function isGenerationStopped(error: unknown): boolean {
  return error instanceof GenerationStoppedError;
}

export function toUserMessage(error: unknown): string {
  if (error instanceof GenerationStoppedError) return "Stopped.";
  if (error instanceof AppError) return error.userMessage;
  if (error instanceof ClaudeError) {
    if (error.kind === "refusal") {
      return "Claude declined this request, so I have no answer for it. Try rewording the question.";
    }
    const lead = error.afterFallback ? "Grok was unavailable, and the Claude backup" : "Claude";
    if (isBillingError(error)) {
      return `${lead} has no Anthropic credit left, so I did not get an answer. Add credit at https://platform.claude.com (Settings → Billing), then try again.`;
    }
    if (error.status === 401 || error.status === 403) {
      return `${lead} was refused because Anthropic rejected the API key, so I did not get an answer. Check ANTHROPIC_API_KEY on the server, then try again.`;
    }
    if (error.afterFallback) {
      return "Grok was unavailable and the Claude backup also failed. I did not get an answer. Try again in a few minutes.";
    }
    return "I couldn't get a response from Claude. Check the Anthropic API key and account credits, then try again.";
  }
  if (error instanceof GrokError) {
    if (isBillingError(error)) {
      return "Grok reports that the account needs credits or an active subscription. Check account usage at https://grok.com/?_s=usage, then try again.";
    }
    return "I couldn't get a response from Grok. Check your xAI API key and account credits, then try again.";
  }
  return "I couldn't complete that because the data service returned an error. I did not guess a result.";
}
