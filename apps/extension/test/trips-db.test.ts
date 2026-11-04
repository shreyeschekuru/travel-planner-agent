import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { createTripsDb } from "../src/worker/trips-db.js";
import { itinerary } from "./fixtures.js";

describe("trips db", () => {
  it("stores, lists newest first, updates status and deletes", async () => {
    const db = createTripsDb(new IDBFactory());
    await db.put(
      itinerary("6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a01", { created_at: "2026-11-01T10:00:00.000Z" }),
    );
    await db.put(
      itinerary("6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a02", { created_at: "2026-11-03T10:00:00.000Z" }),
    );
    expect((await db.list()).map((t) => t.session_id.slice(-2))).toEqual(["02", "01"]);
    await db.setStatus("6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a01", "booked");
    expect((await db.list()).find((t) => t.session_id.endsWith("01"))?.status).toBe("booked");
    await db.delete("6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a02");
    expect(await db.list()).toHaveLength(1);
  });

  it("rejects itineraries that don't match the schema", async () => {
    const db = createTripsDb(new IDBFactory());
    await expect(
      db.put({ ...itinerary("6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a03"), total_usd: -1 }),
    ).rejects.toThrow();
  });
});
