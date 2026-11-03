import { z } from "zod";

export const ErrorCode = z.enum([
  "NETWORK_ERROR",
  "PROVIDER_TIMEOUT",
  "PROVIDER_RATE_LIMIT",
  "PROVIDER_BAD_PAYLOAD",
  "INVALID_INPUT",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "SESSION_EXPIRED",
  "RATE_LIMITED",
  "SPEND_CAP",
  "UNKNOWN_ERROR",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z.object({
  code: ErrorCode,
  message: z.string().max(300),
  retryable: z.boolean(),
});
export type ApiError = z.infer<typeof ApiError>;
