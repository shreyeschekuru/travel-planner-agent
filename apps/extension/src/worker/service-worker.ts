import { createApiClient } from "./api.js";
import { TripController } from "./controller.js";
import { createInstallTokenProvider } from "./install.js";
import type { WorkerRequest, WorkerResponses } from "./messages.js";
import { createTripsDb } from "./trips-db.js";

const apiBase = import.meta.env.VITE_API_BASE;
const getToken = createInstallTokenProvider({
  apiBase,
  version: chrome.runtime.getManifest().version,
  storage: chrome.storage.local,
  fetch: (...args) => fetch(...args),
});

const controller = new TripController({
  api: createApiClient({ apiBase, token: getToken }),
  token: getToken,
  storage: chrome.storage.session,
  trips: createTripsDb(),
  // Any extension API call resets the worker's idle timer while a stream is open.
  keepAlive: () => void chrome.storage.session.getBytesInUse(null),
});

async function handle(msg: WorkerRequest): Promise<WorkerResponses[WorkerRequest["type"]]> {
  switch (msg.type) {
    case "status":
      try {
        await getToken();
        await controller.resume();
        return { registered: true };
      } catch {
        return { registered: false, error: "Couldn't reach Travellite. Try again shortly." };
      }
    case "start":
      return controller.start(msg.config);
    case "prefetch":
      controller.prefetch(msg.req);
      return { ok: true };
    case "refine":
      return controller.refine(msg.body);
    case "select":
      return controller.select(msg.package_id);
    case "reset":
      await controller.reset();
      return { ok: true };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void getToken().catch(() => undefined);
});

// The worker can be stopped at any time; pick up an unfinished trip when it starts again.
void controller.resume();

chrome.runtime.onMessage.addListener((msg: WorkerRequest, _sender, sendResponse) => {
  void handle(msg).then(sendResponse);
  return true; // keep the channel open for the async response
});
