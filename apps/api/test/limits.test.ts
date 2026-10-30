import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/limits/rate-limit.js";
import { RedisSemaphore, SemaphoreTimeoutError } from "../src/limits/semaphore.js";
import { NANO_PER_USD, SpendGuard } from "../src/limits/spend.js";
import { useRedis } from "./helpers.js";

const redis = useRedis();
const T0 = Date.parse("2026-10-30T12:00:00Z");

describe("RateLimiter", () => {
  it("allows up to max, then denies with retry-after", async () => {
    const rl = new RateLimiter(redis());
    const limit = { max: 3, windowSeconds: 60 };
    for (let i = 0; i < 3; i++) expect((await rl.hit("g", "s", limit, T0)).allowed).toBe(true);
    const denied = await rl.hit("g", "s", limit, T0);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("starts a new window", async () => {
    const rl = new RateLimiter(redis());
    const limit = { max: 1, windowSeconds: 60 };
    expect((await rl.hit("g", "s", limit, T0)).allowed).toBe(true);
    expect((await rl.hit("g", "s", limit, T0)).allowed).toBe(false);
    expect((await rl.hit("g", "s", limit, T0 + 61_000)).allowed).toBe(true);
  });

  it("limits per token and per IP independently", async () => {
    const rl = new RateLimiter(redis());
    // sessions: 20/h per token, 100/h per IP
    for (let i = 0; i < 20; i++) {
      expect((await rl.check("sessions", { token: "t1", ip: "1.1.1.1" }, T0)).allowed).toBe(true);
    }
    expect((await rl.check("sessions", { token: "t1", ip: "1.1.1.1" }, T0)).allowed).toBe(false);
    // Another token from the same IP is still allowed.
    expect((await rl.check("sessions", { token: "t2", ip: "1.1.1.1" }, T0)).allowed).toBe(true);
  });

  it("keeps groups separate", async () => {
    const rl = new RateLimiter(redis());
    for (let i = 0; i < 10; i++) await rl.check("install", { ip: "2.2.2.2" }, T0);
    expect((await rl.check("install", { ip: "2.2.2.2" }, T0)).allowed).toBe(false);
    expect((await rl.check("prefetch", { token: "t", ip: "2.2.2.2" }, T0)).allowed).toBe(true);
  });
});

describe("SpendGuard", () => {
  it("reserves under the cap and refuses over it", async () => {
    const spend = new SpendGuard(redis(), 1); // $1 cap
    const r1 = await spend.reserve(0.6 * NANO_PER_USD, T0);
    expect(r1).not.toBeNull();
    expect(await spend.reserve(0.6 * NANO_PER_USD, T0)).toBeNull();
    expect(await spend.spentTodayUsd(T0)).toBeCloseTo(0.6);
  });

  it("settles to the actual amount", async () => {
    const spend = new SpendGuard(redis(), 1);
    const r = await spend.reserve(0.6 * NANO_PER_USD, T0);
    await spend.settle(r!, 0.1 * NANO_PER_USD);
    expect(await spend.spentTodayUsd(T0)).toBeCloseTo(0.1);
    expect(await spend.reserve(0.8 * NANO_PER_USD, T0)).not.toBeNull();
  });

  it("resets per UTC day", async () => {
    const spend = new SpendGuard(redis(), 1);
    await spend.reserve(0.9 * NANO_PER_USD, T0);
    expect(await spend.reserve(0.9 * NANO_PER_USD, T0 + 86_400_000)).not.toBeNull();
  });
});

describe("RedisSemaphore", () => {
  it("limits concurrent holders and frees slots on release", async () => {
    const sem = new RedisSemaphore(redis(), "t", 2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    await expect(sem.acquire(100)).rejects.toBeInstanceOf(SemaphoreTimeoutError);
    await r1();
    const r3 = await sem.acquire(500);
    await r2();
    await r3();
  });

  it("expires leases from crashed holders", async () => {
    const sem = new RedisSemaphore(redis(), "lease", 1, 100);
    await sem.acquire(); // never released
    await new Promise((r) => setTimeout(r, 150));
    const release = await sem.acquire(500);
    await release();
  });

  it("run() releases on error", async () => {
    const sem = new RedisSemaphore(redis(), "run", 1);
    await expect(sem.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await (
      await sem.acquire(200)
    )();
  });
});
