import type { Option, OptionCategory, ProviderErrorKind } from "@travellite/schema";

export type ProviderName = "duffel" | "viator";

export interface ProviderError {
  kind: ProviderErrorKind;
  retry_after_ms?: number;
  /** For logs only; never sent to clients. */
  detail?: string;
}

export type Result<T, E = ProviderError> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const fail = (kind: ProviderErrorKind, extra: Omit<ProviderError, "kind"> = {}) =>
  ({ ok: false, error: { kind, ...extra } }) as const;

export interface SearchProvider<P> {
  name: ProviderName;
  category: OptionCategory;
  search(params: P, signal?: AbortSignal): Promise<Result<Option[]>>;
}
