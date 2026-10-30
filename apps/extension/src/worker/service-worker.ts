import { createInstallTokenProvider } from "./install.js";
import type { WorkerRequest, WorkerResponse } from "./messages.js";

const getToken = createInstallTokenProvider({
  apiBase: import.meta.env.VITE_API_BASE,
  version: chrome.runtime.getManifest().version,
  storage: chrome.storage.local,
  fetch: (...args) => fetch(...args),
});

async function status(): Promise<WorkerResponse> {
  try {
    await getToken();
    return { type: "status", registered: true };
  } catch {
    return {
      type: "status",
      registered: false,
      error: "Couldn't reach Travellite. Try again shortly.",
    };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void getToken().catch(() => undefined);
});

chrome.runtime.onMessage.addListener((msg: WorkerRequest, _sender, sendResponse) => {
  if (msg.type === "status") {
    void status().then(sendResponse);
    return true; // keep the channel open for the async response
  }
  return false;
});
