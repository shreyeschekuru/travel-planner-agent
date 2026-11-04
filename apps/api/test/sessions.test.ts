import type {
  CreateSessionResponse,
  InstallResponse,
  SavedItinerary,
  SessionEvent,
  VacationConfig,
} from "@travellite/schema";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createDeps, type Deps } from "../src/deps.js";
import { isAllowedBookingUrl } from "../src/providers/normalize.js";
import { keys } from "../src/store/keys.js";
import { fakeExplainLlm } from "./fake-llm.js";
import { testConfig, useRedis } from "./helpers.js";

const redis = useRedis();

let app: FastifyInstance;
let deps: Deps;
let base: string;
let llmCalls: () => number;

async function start(env: Record<string, string> = {}) {
  const fake = fakeExplainLlm("grounded");
  llmCalls = () => fake.stream.mock.calls.length;
  deps = createDeps(
    testConfig({ DUFFEL_RATE_PER_SEC: "100", VIATOR_RATE_PER_SEC: "100", ...env }),
    redis(),
    fake.messages,
    { providers: { sleep: async () => {} }, sseHeartbeatMs: 200, log: () => {} },
  );
  // The test HTTP client can leave a fresh, unused socket open, which would stall close().
  app = await buildApp(deps, { forceCloseConnections: true });
  base = await app.listen({ port: 0, host: "127.0.0.1" });
}

afterEach(async () => {
  await deps?.runner.idle();
  await app?.close();
});

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const trip = (o: Partial<VacationConfig> = {}): VacationConfig => ({
  origin: "JFK",
  destination: "lisbon-pt",
  departure_date: inDays(40),
  return_date: inDays(45),
  date_flex_days: 0,
  budget_usd: 4000,
  travelers: 2,
  preferences: ["food", "museums"],
  ...o,
});

async function install(): Promise<string> {
  const res = await fetch(`${base}/v1/install`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ extension_version: "0.1.0" }),
  });
  return ((await res.json()) as InstallResponse).install_token;
}

async function post(path: string, token: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function createSession(token: string, config = trip()): Promise<string> {
  const res = await post("/v1/sessions", token, config);
  expect(res.status).toBe(201);
  const body = (await res.json()) as CreateSessionResponse;
  expect(body.stream_url).toBe(`/v1/sessions/${body.session_id}/events`);
  return body.session_id;
}

interface Received {
  id: string;
  event: SessionEvent["event"];
  data: unknown;
}

/** Reads the SSE stream until `until` matches an event (then disconnects) or the server ends it. */
async function readEvents(
  sessionId: string,
  token: string,
  opts: { until?: (e: Received) => boolean; lastEventId?: string; origin?: string } = {},
): Promise<{ status: number; events: Received[] }> {
  const controller = new AbortController();
  const res = await fetch(`${base}/v1/sessions/${sessionId}/events`, {
    headers: {
      authorization: `Bearer ${token}`,
      ...(opts.lastEventId ? { "last-event-id": opts.lastEventId } : {}),
      ...(opts.origin ? { origin: opts.origin } : {}),
    },
    signal: controller.signal,
  });
  const events: Received[] = [];
  if (res.status !== 200 || !res.body) return { status: res.status, events };
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (frame.startsWith(":")) continue;
        const field = (name: string) =>
          frame
            .split("\n")
            .find((l) => l.startsWith(`${name}: `))
            ?.slice(name.length + 2);
        const e = {
          id: field("id")!,
          event: field("event") as Received["event"],
          data: JSON.parse(field("data")!),
        };
        events.push(e);
        if (opts.until?.(e)) {
          controller.abort();
          return { status: res.status, events };
        }
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) throw err;
  } finally {
    clearTimeout(timeout);
  }
  return { status: res.status, events };
}

const finished = (e: Received) =>
  ["awaiting_selection", "budget_advice", "error"].includes(e.event);

describe("full session", () => {
  it("streams results, packages, explanations, then awaiting_selection", async () => {
    await start();
    const token = await install();
    const id = await createSession(token);
    const { events } = await readEvents(id, token, { until: finished });

    const names = events.map((e) => e.event);
    expect(names.slice(0, 3)).toEqual(["results", "results", "results"]);
    expect(names[3]).toBe("packages");
    const packages = events[3]!.data as { id: string }[];
    expect(packages.length).toBeGreaterThanOrEqual(2);
    expect(names.filter((n) => n === "explanation")).toHaveLength(packages.length);
    expect(names.at(-1)).toBe("awaiting_selection");
    expect(llmCalls()).toBe(1);

    const session = await deps.sessions.get(id);
    expect(session?.status).toBe("awaiting_selection");
    expect(session?.explanations).toHaveLength(packages.length);
    expect(session?.results.flight?.option_ids).toHaveLength(10);
  });

  it("loses no events across a disconnect and resume", async () => {
    await start();
    const token = await install();
    const id = await createSession(token);
    const first = await readEvents(id, token, { until: (e) => e.event === "packages" });
    const resumed = await readEvents(id, token, {
      lastEventId: first.events.at(-1)!.id,
      until: finished,
    });
    const all = await readEvents(id, token, { until: finished });

    const joined = [...first.events, ...resumed.events].map((e) => e.id);
    expect(joined).toEqual(all.events.map((e) => e.id));
    expect(new Set(joined).size).toBe(joined.length);
  });

  it("reports a degraded category and still builds packages", async () => {
    await start();
    const token = await install();
    const id = await createSession(token, trip({ destination: "cancun-mx" }));
    const { events } = await readEvents(id, token, { until: finished });
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "degraded",
        data: { category: "activity", error_kind: "UNAVAILABLE" },
      }),
    );
    expect(events.at(-1)!.event).toBe("awaiting_selection");
  });

  it("returns budget advice without calling the LLM when nothing fits", async () => {
    await start();
    const token = await install();
    const id = await createSession(token, trip({ destination: "reykjavik-is", budget_usd: 1500 }));
    const { events } = await readEvents(id, token, { until: finished });
    const last = events.at(-1)!;
    expect(last.event).toBe("budget_advice");
    expect((last.data as { cheapest_total_usd: number }).cheapest_total_usd).toBeGreaterThan(1500);
    expect(llmCalls()).toBe(0);
  });
});

describe("session access", () => {
  it("is 404 for another install's token and for malformed IDs", async () => {
    await start();
    const owner = await install();
    const other = await install();
    const id = await createSession(owner);
    expect((await readEvents(id, other)).status).toBe(404);
    expect((await readEvents("not-a-uuid", owner)).status).toBe(404);
    expect((await post(`/v1/sessions/${id}/select`, other, { package_id: "x" })).status).toBe(404);
  });

  it("checks Origin on the event stream when extension IDs are configured", async () => {
    const extId = "a".repeat(32);
    await start({ EXTENSION_IDS: extId });
    const token = await install();
    const id = await createSession(token);
    expect(
      (await readEvents(id, token, { origin: `chrome-extension://${"b".repeat(32)}` })).status,
    ).toBe(403);
    expect((await readEvents(id, token)).status).toBe(403);
    const ok = await readEvents(id, token, {
      origin: `chrome-extension://${extId}`,
      until: finished,
    });
    expect(ok.status).toBe(200);
  });

  it.each([
    ["an unknown city", { destination: "atlantis-zz" }],
    ["a past departure", { departure_date: "2020-01-01", return_date: "2020-01-05" }],
    ["return before departure", { return_date: inDays(30) }],
    ["a budget below the minimum", { budget_usd: 50 }],
  ])("rejects %s", async (_label, change) => {
    await start();
    const token = await install();
    const res = await post("/v1/sessions", token, trip(change));
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/sessions/:id/select", () => {
  async function ready() {
    await start();
    const token = await install();
    const id = await createSession(token);
    const { events } = await readEvents(id, token, { until: finished });
    const packages = events.find((e) => e.event === "packages")!.data as {
      id: string;
      label: string;
    }[];
    return { token, id, packages };
  }

  it("returns the itinerary with server-resolved links, then deletes the session", async () => {
    const { token, id, packages } = await ready();
    const res = await post(`/v1/sessions/${id}/select`, token, { package_id: packages[0]!.id });
    expect(res.status).toBe(200);
    const it = (await res.json()) as SavedItinerary;
    expect(it).toMatchObject({
      session_id: id,
      package_label: packages[0]!.label,
      status: "saved",
    });
    for (const link of [it.selections.flight, it.selections.hotel, ...it.selections.activities]) {
      expect(isAllowedBookingUrl(link.url)).toBe(true);
    }
    expect(await redis().exists(keys.session(id), keys.events(id))).toBe(0);
    // A second select finds nothing.
    expect(
      (await post(`/v1/sessions/${id}/select`, token, { package_id: packages[0]!.id })).status,
    ).toBe(404);
  });

  it("rejects an unknown package_id", async () => {
    const { token, id } = await ready();
    const res = await post(`/v1/sessions/${id}/select`, token, { package_id: "pkg_nope" });
    expect(res.status).toBe(400);
    expect(await deps.sessions.get(id)).not.toBeNull();
  });

  it("lets only one of two concurrent selects succeed", async () => {
    const { token, id, packages } = await ready();
    const body = { package_id: packages[0]!.id };
    const statuses = (
      await Promise.all([
        post(`/v1/sessions/${id}/select`, token, body),
        post(`/v1/sessions/${id}/select`, token, body),
      ])
    ).map((r) => r.status);
    expect(statuses.sort()).toEqual([200, 404]);
  });

  it("ends open event streams when the server shuts down", async () => {
    const { token, id } = await ready();
    // Without forced closing, so this checks the preClose hook itself.
    await app.close();
    app = await buildApp(deps);
    base = await app.listen({ port: 0, host: "127.0.0.1" });
    const stream = readEvents(id, token);
    await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(1000);
    expect((await stream).events.at(-1)!.event).toBe("awaiting_selection");
  });

  it("ends an open event stream once the session is gone", async () => {
    const { token, id, packages } = await ready();
    const stream = readEvents(id, token); // stays open after awaiting_selection
    await post(`/v1/sessions/${id}/select`, token, { package_id: packages[0]!.id });
    const { events } = await stream;
    expect(events.at(-1)!.event).toBe("awaiting_selection");
  });
});

describe("restart recovery", () => {
  it("finishes an interrupted session without repeating events", async () => {
    await start();
    const token = await install();
    const id = await createSession(token);
    await deps.runner.idle();
    // Rewind to the state an instance would leave if it died right after the packages event.
    const all = await deps.events.readAfter(id);
    const cut = all.findIndex((e) => e.event.event === "packages");
    await deps.events.delete(id);
    for (const e of all.slice(0, cut + 1)) await deps.events.append(id, e.event);
    const s = (await deps.sessions.get(id))!;
    await deps.sessions.put({ ...s, status: "searching", explanations: [] });

    expect(await deps.runner.recover()).toBe(1);
    await deps.runner.idle();

    const after = (await deps.events.readAfter(id)).map((e) => e.event.event);
    expect(after).toEqual(all.map((e) => e.event.event));
    expect((await deps.sessions.get(id))?.status).toBe("awaiting_selection");
  });

  it("runs a session once even when started twice", async () => {
    await start();
    const token = await install();
    const id = await createSession(token);
    deps.runner.start(id);
    await deps.runner.run(id); // a second instance's attempt
    await deps.runner.idle();
    const names = (await deps.events.readAfter(id)).map((e) => e.event.event);
    expect(names.filter((n) => n === "packages")).toHaveLength(1);
    expect(llmCalls()).toBe(1);
  });
});
