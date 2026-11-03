import { describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "../src/providers/breaker.js";
import type { HttpResponse, Transport } from "../src/providers/http.js";
import { ResilientHttp, retryAfterMs } from "../src/providers/resilience.js";
import { TokenBucket } from "../src/providers/token-bucket.js";
import { useRedis } from "./helpers.js";

const res = (status: number, headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers,
  body: {},
});

function setup(
  responses: (HttpResponse | "hang" | "throw")[],
  opts: { breaker?: CircuitBreaker } = {},
) {
  const queue = [...responses];
  const transport = vi.fn<Transport>(async (_req, signal) => {
    const next = queue.shift() ?? res(200);
    if (next === "throw") throw new Error("ECONNRESET");
    if (next === "hang") {
      return new Promise<never>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      );
    }
    return next;
  });
  const sleeps: number[] = [];
  const http = new ResilientHttp({
    provider: "duffel",
    transport,
    breaker: opts.breaker ?? new CircuitBreaker(),
    bucket: { take: async () => ({ allowed: true, waitMs: 0 }) },
    timeoutMs: 50,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
  });
  const call = () => http.request({ method: "GET", url: "https://api.duffel.com/x" });
  return { transport, sleeps, call };
}

describe("ResilientHttp", () => {
  it("times out without retrying", async () => {
    const { transport, call } = setup(["hang"]);
    expect(await call()).toMatchObject({ ok: false, error: { kind: "TIMEOUT" } });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx once, with jitter", async () => {
    const { transport, sleeps, call } = setup([res(503), res(200)]);
    expect((await call()).ok).toBe(true);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([350]);
  });

  it("gives up after the one retry", async () => {
    const { transport, call } = setup([res(502), res(503), res(200)]);
    expect(await call()).toMatchObject({ ok: false, error: { kind: "UNAVAILABLE" } });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("retries network errors once", async () => {
    const { transport, call } = setup(["throw", res(200)]);
    expect((await call()).ok).toBe(true);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("honors retry-after on 429", async () => {
    const { sleeps, call } = setup([res(429, { "retry-after": "0.4" }), res(200)]);
    expect((await call()).ok).toBe(true);
    expect(sleeps).toEqual([400]);
  });

  it("does not wait out a long retry-after", async () => {
    const { transport, call } = setup([res(429, { "retry-after": "30" })]);
    expect(await call()).toMatchObject({
      ok: false,
      error: { kind: "RATE_LIMIT", retry_after_ms: 30_000 },
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, "AUTH"],
    [403, "AUTH"],
    [404, "NOT_FOUND"],
    [422, "NOT_FOUND"],
  ])("maps %i to %s without retrying", async (status, kind) => {
    const { transport, call } = setup([res(status)]);
    expect(await call()).toMatchObject({ ok: false, error: { kind } });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("fails fast when the shared bucket is empty", async () => {
    const http = new ResilientHttp({
      provider: "viator",
      transport: async () => res(200),
      breaker: new CircuitBreaker(),
      bucket: { take: async () => ({ allowed: false, waitMs: 5000 }) },
      timeoutMs: 50,
    });
    expect(await http.request({ method: "GET", url: "https://api.viator.com/x" })).toMatchObject({
      ok: false,
      error: { kind: "RATE_LIMIT" },
    });
  });
});

describe("CircuitBreaker", () => {
  it("opens after 5 failures in 60 s, then half-opens after 30 s", async () => {
    let now = 0;
    const breaker = new CircuitBreaker({ now: () => now });
    const { transport, call } = setup(Array(10).fill("hang"), { breaker });
    for (let i = 0; i < 5; i++) await call();
    expect(breaker.state).toBe("open");
    expect(await call()).toMatchObject({ ok: false, error: { kind: "BREAKER_OPEN" } });
    expect(transport).toHaveBeenCalledTimes(5);

    now = 30_000;
    expect(breaker.state).toBe("half_open");
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(false); // one trial at a time
    breaker.onSuccess();
    expect(breaker.state).toBe("closed");
  });

  it("reopens when the half-open trial fails", () => {
    let now = 0;
    const breaker = new CircuitBreaker({ now: () => now });
    for (let i = 0; i < 5; i++) breaker.onFailure();
    now = 31_000;
    expect(breaker.tryAcquire()).toBe(true);
    breaker.onFailure();
    expect(breaker.state).toBe("open");
  });

  it("forgets failures older than the window", () => {
    let now = 0;
    const breaker = new CircuitBreaker({ now: () => now });
    for (let i = 0; i < 4; i++) breaker.onFailure();
    now = 61_000;
    breaker.onFailure();
    expect(breaker.state).toBe("closed");
  });
});

describe("retryAfterMs", () => {
  it("parses seconds and HTTP dates", () => {
    expect(retryAfterMs("2")).toBe(2000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(retryAfterMs("soon")).toBeUndefined();
  });
});

describe("TokenBucket", () => {
  const redis = useRedis();

  it("is shared by every instance using the same name", async () => {
    const a = new TokenBucket(redis(), "duffel", 2, 2);
    const b = new TokenBucket(redis(), "duffel", 2, 2);
    const now = 1_000_000;
    expect((await a.take(now)).allowed).toBe(true);
    expect((await b.take(now)).allowed).toBe(true);
    const denied = await a.take(now);
    expect(denied).toEqual({ allowed: false, waitMs: 500 });
    expect((await b.take(now + 500)).allowed).toBe(true);
  });
});
