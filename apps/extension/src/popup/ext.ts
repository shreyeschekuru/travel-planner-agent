import { useEffect, useState } from "react";
import type { WorkerRequest, WorkerResponses } from "../worker/messages.js";

/** Sends a message to the service worker and returns its typed reply. */
export function send<T extends WorkerRequest>(msg: T): Promise<WorkerResponses[T["type"]]> {
  return chrome.runtime.sendMessage(msg) as Promise<WorkerResponses[T["type"]]>;
}

/**
 * A value in chrome.storage, kept current through storage.onChanged. `undefined` until the
 * first read finishes, `null` when the key is absent.
 */
export function useStored<T>(area: "local" | "session", key: string): T | null | undefined {
  const [value, setValue] = useState<T | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void chrome.storage[area].get(key).then((items) => {
      if (live) setValue((items[key] as T | undefined) ?? null);
    });
    const onChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      changedArea: string,
    ) => {
      if (changedArea === area && key in changes)
        setValue((changes[key]!.newValue as T | undefined) ?? null);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => {
      live = false;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, [area, key]);
  return value;
}
