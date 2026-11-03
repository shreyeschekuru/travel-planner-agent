import { InstallResponse } from "@travellite/schema";

const TOKEN_KEY = "install_token";

export interface InstallDeps {
  apiBase: string;
  version: string;
  storage: Pick<chrome.storage.StorageArea, "get" | "set">;
  fetch: typeof fetch;
}

/**
 * Returns the stored install token, registering with the API on first use.
 * Concurrent callers share one in-flight registration.
 */
export function createInstallTokenProvider(deps: InstallDeps) {
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

  return async function getToken(): Promise<string> {
    const stored = (await deps.storage.get(TOKEN_KEY))[TOKEN_KEY];
    if (typeof stored === "string" && stored.length > 0) return stored;
    pending ??= register().finally(() => {
      pending = null;
    });
    return pending;
  };
}
