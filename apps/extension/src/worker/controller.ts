import type {
  ApiError,
  PrefetchRequest,
  RefineRequest,
  SavedItinerary,
  VacationConfig,
} from "@travellite/schema";
import { ApiCallError, type ApiClient } from "./api.js";
import type { TokenProvider } from "./install.js";
import { compareEventIds, openEventStream, type EventStreamOptions } from "./sse.js";
import { canRefine, initialTrip, isWorking, reduceTrip, type TripState } from "./trip-state.js";
import type { TripsDb } from "./trips-db.js";

export const TRIP_KEY = "trip";
/** Identical prefetches within this window are sent once. */
const PREFETCH_DEDUPE_MS = 60_000;

export interface ControllerDeps {
  api: ApiClient;
  token: TokenProvider;
  /** chrome.storage.session: survives the popup closing and the worker restarting. */
  storage: Pick<chrome.storage.StorageArea, "get" | "set" | "remove">;
  trips: TripsDb;
  openStream?: (opts: EventStreamOptions) => { close: () => void; done: Promise<void> };
  /** Touches an extension API so Chrome doesn't stop the worker mid-stream. */
  keepAlive?: () => void;
  now?: () => number;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: ApiError };

const expired: ApiError = {
  code: "SESSION_EXPIRED",
  message: "This trip has expired. Plan it again to see fresh prices.",
  retryable: false,
};

function toError(err: unknown): ApiError {
  if (err instanceof ApiCallError) return err.status === 404 ? expired : err.body;
  return { code: "UNKNOWN_ERROR", message: "Something went wrong", retryable: true };
}

/**
 * Owns the current trip in the service worker: API calls, the event stream, and the state the
 * popup renders. All state lives in storage, so the popup can close and the worker can restart
 * at any point; resume() picks up from the last stored event.
 */
export class TripController {
  private state: TripState | null = null;
  private loaded = false;
  private stream: { close: () => void; session: string } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private recentPrefetch = new Map<string, number>();

  constructor(private readonly deps: ControllerDeps) {}

  /** Serialized read-modify-write of the stored trip. */
  private update(fn: (s: TripState | null) => TripState | null): Promise<TripState | null> {
    const next = this.queue.then(async () => {
      if (!this.loaded) await this.load();
      const updated = fn(this.state);
      if (updated !== this.state) {
        this.state = updated;
        if (updated) await this.deps.storage.set({ [TRIP_KEY]: updated });
        else await this.deps.storage.remove(TRIP_KEY);
      }
      return this.state;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<void> {
    const stored = (await this.deps.storage.get(TRIP_KEY))[TRIP_KEY] as TripState | undefined;
    this.state = stored ?? null;
    this.loaded = true;
  }

  async current(): Promise<TripState | null> {
    return this.update((s) => s);
  }

  /** Reconnects a trip the server is still working on, e.g. after the worker restarted. */
  async resume(): Promise<void> {
    const s = await this.current();
    if (s && isWorking(s.phase)) this.connect(s.session_id);
  }

  async start(config: VacationConfig): Promise<Outcome<TripState>> {
    this.disconnect();
    try {
      const { session_id } = await this.deps.api.createSession(config);
      const s = await this.update(() => initialTrip(session_id, config));
      this.connect(session_id);
      return { ok: true, value: s! };
    } catch (err) {
      return { ok: false, error: toError(err) };
    }
  }

  prefetch(req: PrefetchRequest): void {
    const key = JSON.stringify(req);
    const now = (this.deps.now ?? Date.now)();
    if (now - (this.recentPrefetch.get(key) ?? -Infinity) < PREFETCH_DEDUPE_MS) return;
    this.recentPrefetch.set(key, now);
    // Best effort: a failed prefetch only means the session searches from scratch.
    void this.deps.api.prefetch(req).catch(() => undefined);
  }

  async refine(body: RefineRequest): Promise<Outcome<{ reason: string; changed: boolean }>> {
    const s = await this.current();
    if (!s || !canRefine(s)) {
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "This trip can't be refined right now",
          retryable: false,
        },
      };
    }
    try {
      const { delta, changed } = await this.deps.api.refine(s.session_id, body);
      await this.update((cur) => {
        if (!cur || cur.session_id !== s.session_id) return cur;
        // Mirrors the refine_applied event, which arrives on the stream only when we reconnect.
        return changed
          ? {
              ...cur,
              phase: "refining",
              refinements: {
                ...cur.refinements,
                pending: delta,
                last: { reason: delta.reason, changed },
              },
            }
          : {
              ...cur,
              refinements: { ...cur.refinements, last: { reason: delta.reason, changed } },
            };
      });
      if (changed) this.connect(s.session_id);
      return { ok: true, value: { reason: delta.reason, changed } };
    } catch (err) {
      const error = toError(err);
      if (error.code === "SESSION_EXPIRED") await this.markExpired(s.session_id);
      return { ok: false, error };
    }
  }

  /** Selects a package, saves the itinerary to IndexedDB, then clears the trip. */
  async select(packageId: string): Promise<Outcome<SavedItinerary>> {
    const s = await this.current();
    if (!s || s.phase !== "ready") {
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "Wait for the trip to finish loading",
          retryable: true,
        },
      };
    }
    try {
      const itinerary = await this.deps.api.select(s.session_id, packageId);
      await this.deps.trips.put(itinerary);
      this.disconnect();
      await this.update(() => null);
      return { ok: true, value: itinerary };
    } catch (err) {
      const error = toError(err);
      if (error.code === "SESSION_EXPIRED") await this.markExpired(s.session_id);
      return { ok: false, error };
    }
  }

  async reset(): Promise<void> {
    this.disconnect();
    await this.update(() => null);
  }

  private markExpired(sessionId: string) {
    return this.update((cur) =>
      cur && cur.session_id === sessionId ? { ...cur, phase: "error", error: expired } : cur,
    );
  }

  private disconnect() {
    this.stream?.close();
    this.stream = null;
  }

  /** Opens the event stream unless one is already open for this session. */
  private connect(sessionId: string) {
    if (this.stream?.session === sessionId) return;
    this.disconnect();
    const open = this.deps.openStream ?? openEventStream;
    const handle = open({
      url: this.deps.api.eventsUrl(sessionId),
      token: this.deps.token,
      lastEventId: () => (this.state?.session_id === sessionId ? this.state.last_event_id : null),
      onEvent: async (id, event) => {
        const s = await this.update((cur) => {
          if (!cur || cur.session_id !== sessionId) return cur;
          if (cur.last_event_id && compareEventIds(id, cur.last_event_id) <= 0) return cur;
          return { ...reduceTrip(cur, event), last_event_id: id };
        });
        // Nothing more will arrive until the next refinement.
        if (!s || s.session_id !== sessionId || !isWorking(s.phase)) this.closeIf(sessionId);
      },
      onState: (state) => {
        const connection = state === "connecting" ? "reconnecting" : state;
        void this.update((cur) =>
          cur && cur.session_id === sessionId && cur.connection !== connection
            ? { ...cur, connection }
            : cur,
        );
      },
      onPing: () => this.deps.keepAlive?.(),
      onGone: () => {
        void this.markExpired(sessionId);
        this.closeIf(sessionId);
      },
    });
    this.stream = { close: handle.close, session: sessionId };
  }

  private closeIf(sessionId: string) {
    if (this.stream?.session === sessionId) this.disconnect();
  }
}
