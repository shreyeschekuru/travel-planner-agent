export interface BreakerOptions {
  failureThreshold?: number;
  windowMs?: number;
  openMs?: number;
  now?: () => number;
}

/**
 * Per-instance circuit breaker: opens after `failureThreshold` failures within `windowMs`,
 * then lets one trial request through after `openMs` (half-open).
 */
export class CircuitBreaker {
  private failures: number[] = [];
  private openedAt: number | null = null;
  private trialInFlight = false;
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly openMs: number;
  private readonly now: () => number;

  constructor(opts: BreakerOptions = {}) {
    this.threshold = opts.failureThreshold ?? 5;
    this.windowMs = opts.windowMs ?? 60_000;
    this.openMs = opts.openMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  get state(): "closed" | "open" | "half_open" {
    if (this.openedAt === null) return "closed";
    return this.now() - this.openedAt >= this.openMs ? "half_open" : "open";
  }

  /** Returns false when the request must not be sent. */
  tryAcquire(): boolean {
    const state = this.state;
    if (state === "closed") return true;
    if (state === "open" || this.trialInFlight) return false;
    this.trialInFlight = true;
    return true;
  }

  onSuccess(): void {
    this.failures = [];
    this.openedAt = null;
    this.trialInFlight = false;
  }

  onFailure(): void {
    const now = this.now();
    if (this.state === "half_open") {
      this.openedAt = now;
      this.trialInFlight = false;
      return;
    }
    this.failures = this.failures.filter((t) => now - t < this.windowMs);
    this.failures.push(now);
    if (this.failures.length >= this.threshold) {
      this.openedAt = now;
      this.failures = [];
    }
  }

  /** For requests that ended without telling us anything about provider health. */
  release(): void {
    this.trialInFlight = false;
  }
}
