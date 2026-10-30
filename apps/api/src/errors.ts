import type { ApiError, ErrorCode } from "@travellite/schema";

/** An error that is safe to show the client. Anything else becomes UNKNOWN_ERROR. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }

  toBody(): ApiError {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}
