import { describe, expect, it, vi } from "vitest";
import { ApiCallError, createApiClient } from "../src/worker/api.js";
import type { TokenProvider } from "../src/worker/install.js";

function tokens(...values: string[]): TokenProvider & { reset: ReturnType<typeof vi.fn> } {
  let i = 0;
  const fn = (async () => values[Math.min(i, values.length - 1)]!) as TokenProvider;
  const reset = vi.fn(async () => void i++);
  return Object.assign(fn, { reset });
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("api client", () => {
  it("sends the token and parses responses", async () => {
    const fetch = vi.fn(async () =>
      json(201, { session_id: "8b0f1c1e-1d1e-4c8e-9b6a-0e4f1c2d3a4b", stream_url: "/x" }),
    );
    const api = createApiClient({
      apiBase: "http://api",
      token: tokens("t1"),
      fetch: fetch as never,
    });
    const res = await api.createSession({} as never);
    expect(res.session_id).toMatch(/^8b0f/);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api/v1/sessions");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer t1");
  });

  it("re-registers once when the token is rejected", async () => {
    const t = tokens("old", "new");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(401, { code: "UNAUTHORIZED", message: "no", retryable: false }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const api = createApiClient({ apiBase: "http://api", token: t, fetch: fetch as never });
    await api.prefetch({} as never);
    expect(t.reset).toHaveBeenCalledTimes(1);
    expect(new Headers((fetch.mock.calls[1]![1] as RequestInit).headers).get("authorization")).toBe(
      "Bearer new",
    );
  });

  it("surfaces the server's error body", async () => {
    const fetch = vi.fn(async () =>
      json(400, {
        code: "INVALID_INPUT",
        message: "Couldn't apply that, try a chip",
        retryable: false,
      }),
    );
    const api = createApiClient({
      apiBase: "http://api",
      token: tokens("t"),
      fetch: fetch as never,
    });
    const err = await api.refine("s", { text: "?" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiCallError);
    expect((err as ApiCallError).body.message).toBe("Couldn't apply that, try a chip");
  });

  it("reports network failures as retryable", async () => {
    const api = createApiClient({
      apiBase: "http://api",
      token: tokens("t"),
      fetch: (async () => {
        throw new TypeError("offline");
      }) as never,
    });
    const err = (await api.select("s", "p").catch((e: unknown) => e)) as ApiCallError;
    expect(err.body).toMatchObject({ code: "NETWORK_ERROR", retryable: true });
  });
});
