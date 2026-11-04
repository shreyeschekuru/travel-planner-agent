import { vi } from "vitest";

type Listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;

/** In-memory chrome.storage area that reports changes like the real one. */
export function memoryArea(
  name: string,
  listeners: Set<Listener>,
  initial: Record<string, unknown> = {},
) {
  const data: Record<string, unknown> = structuredClone(initial);
  const emit = (changes: Record<string, chrome.storage.StorageChange>) => {
    for (const l of listeners) l(changes, name);
  };
  const area = {
    data,
    get: vi.fn(async (key?: string | string[] | null) => {
      if (key === undefined || key === null) return structuredClone(data);
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(
        keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]),
      );
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: data[k], newValue: structuredClone(v) };
        data[k] = structuredClone(v);
      }
      emit(changes);
    }),
    remove: vi.fn(async (key: string | string[]) => {
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const k of Array.isArray(key) ? key : [key]) {
        changes[k] = { oldValue: data[k] };
        delete data[k];
      }
      emit(changes);
    }),
    getBytesInUse: vi.fn(async () => 0),
  };
  // Chrome's overloaded signatures can't be matched by a plain object; the behavior is the same.
  return area as typeof area & Pick<chrome.storage.StorageArea, "get" | "set" | "remove">;
}

/** Installs a minimal `chrome` global for popup tests. */
export function installFakeChrome(
  opts: {
    local?: Record<string, unknown>;
    session?: Record<string, unknown>;
    onMessage?: (msg: unknown) => unknown;
  } = {},
) {
  const listeners = new Set<Listener>();
  const local = memoryArea("local", listeners, opts.local);
  const session = memoryArea("session", listeners, opts.session);
  const sendMessage = vi.fn(async (msg: unknown) => opts.onMessage?.(msg) ?? { registered: true });
  const create = vi.fn(async () => ({}));
  const chromeGlobal = {
    storage: {
      local,
      session,
      onChanged: {
        addListener: (l: Listener) => listeners.add(l),
        removeListener: (l: Listener) => listeners.delete(l),
      },
    },
    runtime: { sendMessage },
    tabs: { create },
  };
  vi.stubGlobal("chrome", chromeGlobal);
  return { local, session, sendMessage, tabsCreate: create };
}
