import { describe, expect, it, vi } from "vitest";
import { createInstallTokenProvider } from "../src/worker/install.js";

function memoryStorage(initial: Record<string, unknown> = {}) {
  const data = { ...initial };
  return {
    data,
    get: vi.fn(async (key: string) => (key in data ? { [key]: data[key] } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => void Object.assign(data, items)),
  };
}

const okFetch = () =>
  vi.fn(
    async () => new Response(JSON.stringify({ install_token: "tl1.abc.def" }), { status: 201 }),
  );

describe("install token provider", () => {
  it("registers once and stores the token", async () => {
    const storage = memoryStorage();
    const fetch = okFetch();
    const getToken = createInstallTokenProvider({
      apiBase: "http://api",
      version: "0.1.0",
      storage: storage as never,
      fetch,
    });
    const [a, b] = await Promise.all([getToken(), getToken()]);
    expect(a).toBe("tl1.abc.def");
    expect(b).toBe("tl1.abc.def");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual([
      "http://api/v1/install",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ extension_version: "0.1.0" }),
      }),
    ]);
    expect(storage.data.install_token).toBe("tl1.abc.def");
  });

  it("reuses a stored token without calling the API", async () => {
    const fetch = okFetch();
    const getToken = createInstallTokenProvider({
      apiBase: "http://api",
      version: "0.1.0",
      storage: memoryStorage({ install_token: "tl1.saved.tok" }) as never,
      fetch,
    });
    expect(await getToken()).toBe("tl1.saved.tok");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws on a failed registration and retries next time", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ install_token: "tl1.second.try" }), { status: 201 }),
      );
    const getToken = createInstallTokenProvider({
      apiBase: "http://api",
      version: "0.1.0",
      storage: memoryStorage() as never,
      fetch,
    });
    await expect(getToken()).rejects.toThrow("503");
    expect(await getToken()).toBe("tl1.second.try");
  });
});
