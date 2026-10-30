/** Messages between the popup and the service worker. */
export type WorkerRequest = { type: "status" };
export type WorkerResponse = { type: "status"; registered: boolean; error?: string };
