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

export class GrokError extends Error {
  constructor(message: string, public readonly retryable: boolean, public readonly status = 0) {
    super(message);
    this.name = "GrokError";
  }
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
  if (error instanceof GrokError) {
    if (error.status === 402) {
      return "Grok reports that the account needs credits or an active subscription. Check account usage at https://grok.com/?_s=usage, then try again.";
    }
    return "I couldn't get a response from Grok. Check your xAI API key and account credits, then try again.";
  }
  return "I couldn't complete that because the data service returned an error. I did not guess a result.";
}
