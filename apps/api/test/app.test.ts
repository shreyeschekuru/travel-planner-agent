import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createDeps, type Deps } from "../src/deps.js";
import type { MessagesApi } from "../src/llm/client.js";
import { testConfig, useRedis } from "./helpers.js";

const redis = useRedis();
let app: FastifyInstance;
let deps: Deps;

beforeEach(async () => {
  deps = createDeps(testConfig(), redis(), {} as MessagesApi, { sleep: async () => {} });
  app = await buildApp(deps);
  // A protected test route to exercise the auth and rate-limit hooks.
  app.get("/v1/test/whoami", { config: { rateGroup: "sessions" } }, async (req) => ({
    iid: req.installId,
  }));
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function install(ip = "10.0.0.1") {
  return app.inject({
    method: "POST",
    url: "/v1/install",
    payload: { extension_version: "0.1.0" },
    remoteAddress: ip,
  });
}

describe("GET /health", () => {
  it("is public", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("POST /v1/install", () => {
  it("issues a token that authenticates", async () => {
    const res = await install();
    expect(res.statusCode).toBe(201);
    const { install_token } = res.json();
    const who = await app.inject({
      method: "GET",
      url: "/v1/test/whoami",
      headers: { authorization: `Bearer ${install_token}` },
    });
    expect(who.statusCode).toBe(200);
    expect(who.json().iid).toMatch(/^[0-9a-f]{32}$/);
  });

  it.each([[{}], [{ extension_version: "latest" }], [{ extension_version: "0.1.0", extra: true }]])(
    "rejects invalid body %j with INVALID_INPUT",
    async (payload) => {
      const res = await app.inject({ method: "POST", url: "/v1/install", payload });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "INVALID_INPUT", retryable: false });
    },
  );

  it("rate-limits per IP", async () => {
    for (let i = 0; i < 10; i++) expect((await install("10.0.0.9")).statusCode).toBe(201);
    const res = await install("10.0.0.9");
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect((await install("10.0.0.10")).statusCode).toBe(201);
  });
});

describe("auth", () => {
  it.each([[undefined], ["Bearer not-a-real-token"], ["Basic abc"]])(
    "rejects authorization %j",
    async (authorization) => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/test/whoami",
        ...(authorization ? { headers: { authorization } } : {}),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({
        code: "UNAUTHORIZED",
        message: "Missing or invalid install token",
        retryable: false,
      });
    },
  );

  it("rate-limits per token", async () => {
    const { install_token } = (await install()).json();
    const headers = { authorization: `Bearer ${install_token}` };
    for (let i = 0; i < 20; i++) {
      expect(
        (await app.inject({ method: "GET", url: "/v1/test/whoami", headers })).statusCode,
      ).toBe(200);
    }
    expect((await app.inject({ method: "GET", url: "/v1/test/whoami", headers })).statusCode).toBe(
      429,
    );
  });
});

describe("errors", () => {
  it("returns NOT_FOUND for unknown routes without leaking details", async () => {
    const res = await app.inject({ method: "GET", url: "/health/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ code: "NOT_FOUND", message: "Not found", retryable: false });
  });

  it("rejects oversized bodies", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/install",
      payload: { extension_version: "0.1.0", pad: "x".repeat(20_000) },
    });
    expect(res.statusCode).toBe(413);
  });
});

describe("POST /v1/prefetch", () => {
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const trip = () => ({
    origin: "JFK",
    destination: "lisbon-pt",
    departure_date: inDays(40),
    return_date: inDays(45),
    date_flex_days: 0,
    travelers: 2,
  });

  async function prefetch(payload: object, token?: string) {
    const auth = token ?? (await install()).json().install_token;
    return app.inject({
      method: "POST",
      url: "/v1/prefetch",
      headers: { authorization: `Bearer ${auth}` },
      payload,
    });
  }

  it("returns 202 and warms the flight and hotel caches", async () => {
    const res = await prefetch(trip());
    expect(res.statusCode).toBe(202);
    await deps.search.idle();
    const t = trip();
    const flights = await deps.cache.getJson<unknown[]>(
      `flights:JFK:LIS:${t.departure_date}:${t.return_date}:2`,
    );
    const hotels = await deps.cache.getJson<unknown[]>(
      `hotels:lisbon-pt:${t.departure_date}:${t.return_date}:2`,
    );
    expect(flights).toHaveLength(10);
    expect(hotels).toHaveLength(10);
    expect(await deps.cache.getJson("activities:lisbon-pt")).toBeNull();
  });

  it("warms once for identical requests", async () => {
    const token = (await install()).json().install_token;
    await prefetch(trip(), token);
    await deps.search.idle();
    await deps.cache.setJson(
      `flights:JFK:LIS:${trip().departure_date}:${trip().return_date}:2`,
      [],
      60,
    );
    await prefetch(trip(), token);
    await deps.search.idle();
    // The second request didn't refetch, so the planted value survives.
    expect(
      await deps.cache.getJson(`flights:JFK:LIS:${trip().departure_date}:${trip().return_date}:2`),
    ).toEqual([]);
  });

  it("requires a token", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/prefetch", payload: trip() });
    expect(res.statusCode).toBe(401);
  });

  it.each([
    ["an unknown city", { destination: "atlantis-zz" }],
    ["return before departure", { return_date: inDays(30) }],
    ["a past departure", { departure_date: "2020-01-01", return_date: "2020-01-05" }],
    ["a lowercase IATA code", { origin: "jfk" }],
    ["extra fields", { budget_usd: 2000 }],
  ])("rejects %s", async (_label, change) => {
    const res = await prefetch({ ...trip(), ...change });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_INPUT");
  });
});
