import { InstallResponse } from "@travellite/schema";

const TOKEN_KEY = "install_token";

export interface InstallDeps {
  apiBase: string;
  version: string;
  storage: Pick<chrome.storage.StorageArea, "get" | "set" | "remove">;
  fetch: typeof fetch;
}

export interface TokenProvider {
  (): Promise<string>;
  /** Forget the stored token, e.g. after the API rejects it; the next call re-registers. */
  reset(): Promise<void>;
}

/**
 * Returns the stored install token, registering with the API on first use.
 * Concurrent callers share one in-flight registration.
 */
export function createInstallTokenProvider(deps: InstallDeps): TokenProvider {
  let pending: Promise<string> | null = null;

  async function register(): Promise<string> {
    const res = await deps.fetch(`${deps.apiBase}/v1/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ extension_version: deps.version }),
    });
    if (!res.ok) throw new Error(`Install registration failed (${res.status})`);
    const { install_token } = InstallResponse.parse(await res.json());
    await deps.storage.set({ [TOKEN_KEY]: install_token });
    return install_token;
  }

  const getToken = async (): Promise<string> => {
    const stored = (await deps.storage.get(TOKEN_KEY))[TOKEN_KEY];
    if (typeof stored === "string" && stored.length > 0) return stored;
    pending ??= register().finally(() => {
      pending = null;
    });
    return pending;
  };
  return Object.assign(getToken, { reset: () => deps.storage.remove(TOKEN_KEY) });
}
