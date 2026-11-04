import { SavedItinerary } from "@travellite/schema";

const DB = "travellite";
const STORE = "trips";

function open(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "session_id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(
  idb: IDBFactory,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open(idb).then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(req.result);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      }),
  );
}

/** Saved itineraries in IndexedDB (requirements F7). Shared by the worker and the popup. */
export function createTripsDb(idb: IDBFactory = indexedDB) {
  return {
    async put(trip: SavedItinerary): Promise<void> {
      await run(idb, "readwrite", (s) => s.put(SavedItinerary.parse(trip)));
    },
    /** Newest first. Records that no longer match the schema are skipped. */
    async list(): Promise<SavedItinerary[]> {
      const all = await run<unknown[]>(idb, "readonly", (s) => s.getAll());
      return all
        .flatMap((t) => {
          const parsed = SavedItinerary.safeParse(t);
          return parsed.success ? [parsed.data] : [];
        })
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
    async setStatus(sessionId: string, status: SavedItinerary["status"]): Promise<void> {
      const trip = await run<unknown>(idb, "readonly", (s) => s.get(sessionId));
      const parsed = SavedItinerary.safeParse(trip);
      if (parsed.success) await this.put({ ...parsed.data, status });
    },
    async delete(sessionId: string): Promise<void> {
      await run(idb, "readwrite", (s) => s.delete(sessionId));
    },
  };
}

export type TripsDb = ReturnType<typeof createTripsDb>;
