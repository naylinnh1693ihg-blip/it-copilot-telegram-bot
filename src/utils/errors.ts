export class AppError extends Error {
  constructor(public readonly userMessage: string) {
    super(userMessage);
    this.name = "AppError";
  }
}

export class DatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseError";
  }
}

export class GrokError extends Error {
  constructor(message: string, public readonly retryable: boolean) {
    super(message);
    this.name = "GrokError";
  }
}

export function toUserMessage(error: unknown): string {
  if (error instanceof AppError) return error.userMessage;
  if (error instanceof GrokError) {
    return "I couldn't get a response from Grok. Check your xAI API key and account credits, then try again.";
  }
  return "I couldn't complete that because the data service returned an error. I did not guess a result.";
}
