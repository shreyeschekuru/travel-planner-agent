import type { CircuitBreaker } from "./breaker.js";
import type { HttpRequest, HttpResponse, Transport } from "./http.js";
import { fail, ok, type ProviderError, type ProviderName, type Result } from "./provider.js";
import type { TokenBucket } from "./token-bucket.js";

export interface ResilienceOptions {
  provider: ProviderName;
  transport: Transport;
  breaker: CircuitBreaker;
  bucket: Pick<TokenBucket, "take">;
  /** Per attempt. */
  timeoutMs: number;
  /** Longest we wait for a shared rate-limit token, or for a provider's retry-after. */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

type Attempt =
  | { kind: "response"; res: HttpResponse }
  | { kind: "timeout" }
  | { kind: "network"; detail: string };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Parses retry-after (seconds or an HTTP date) into ms. */
export function retryAfterMs(header: string | undefined, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * One provider's HTTP client: shared token bucket, per-attempt timeout,
 * at most one retry on 429/5xx/network errors (jittered, honoring retry-after),
 * and a circuit breaker.
 */
export class ResilientHttp {
  private readonly maxWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly opts: ResilienceOptions) {
    this.maxWaitMs = opts.maxWaitMs ?? 1000;
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
  }

  get provider(): ProviderName {
    return this.opts.provider;
  }

  async request(req: HttpRequest, signal?: AbortSignal): Promise<Result<HttpResponse>> {
    const { breaker } = this.opts;
    if (!breaker.tryAcquire()) return fail("BREAKER_OPEN");

    let last: ProviderError = { kind: "UNAVAILABLE" };
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        const wait = last.retry_after_ms ?? 200 + this.random() * 300;
        if (wait > this.maxWaitMs) break;
        await this.sleep(wait);
      }
      const token = await this.takeToken();
      if (!token) {
        breaker.release();
        return fail("RATE_LIMIT", { detail: "shared token bucket empty" });
      }

      const outcome = await this.attempt(req, signal);
      if (outcome.kind === "timeout") {
        // A timeout already spent the budget; retrying would blow the stage deadline.
        breaker.onFailure();
        return fail("TIMEOUT");
      }
      if (outcome.kind === "network") {
        last = { kind: "UNAVAILABLE", detail: outcome.detail };
        continue;
      }
      const { res } = outcome;
      if (res.status === 429) {
        const after = retryAfterMs(res.headers["retry-after"]);
        last = { kind: "RATE_LIMIT", ...(after === undefined ? {} : { retry_after_ms: after }) };
        continue;
      }
      if (res.status >= 500) {
        last = { kind: "UNAVAILABLE", detail: `HTTP ${res.status}` };
        continue;
      }
      breaker.onSuccess();
      if (res.status === 401 || res.status === 403) return fail("AUTH");
      // 400/422 from these providers mean the place or dates were rejected.
      if (res.status >= 400) return fail("NOT_FOUND", { detail: `HTTP ${res.status}` });
      return ok(res);
    }
    breaker.onFailure();
    return { ok: false, error: last };
  }

  private async takeToken(): Promise<boolean> {
    const first = await this.opts.bucket.take();
    if (first.allowed) return true;
    if (first.waitMs > this.maxWaitMs) return false;
    await this.sleep(first.waitMs);
    return (await this.opts.bucket.take()).allowed;
  }

  private async attempt(req: HttpRequest, signal?: AbortSignal): Promise<Attempt> {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      // Race against the signal too, in case a transport ignores it.
      const aborted = new Promise<never>((_, reject) => {
        if (combined.aborted) reject(combined.reason);
        combined.addEventListener("abort", () => reject(combined.reason), { once: true });
      });
      // The timeout may fire after the response arrived; that rejection is expected.
      aborted.catch(() => {});
      return {
        kind: "response",
        res: await Promise.race([this.opts.transport(req, combined), aborted]),
      };
    } catch (err) {
      if (combined.aborted) return { kind: "timeout" };
      return { kind: "network", detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
