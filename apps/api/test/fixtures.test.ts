import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fixtureKeyMaterial,
  fixturePath,
  fixtureTransport,
  recordingTransport,
  requestDates,
  shiftDates,
} from "../src/providers/fixtures.js";
import type { HttpRequest } from "../src/providers/http.js";

const req = (depart: string, ret: string, token = "secret-token"): HttpRequest => ({
  method: "POST",
  url: "https://api.duffel.com/air/offer_requests?supplier_timeout=5000&return_offers=true",
  headers: { authorization: `Bearer ${token}` },
  body: {
    data: {
      slices: [{ departure_date: depart }, { departure_date: ret }],
      passengers: [{ type: "adult" }],
    },
  },
});

describe("fixture keys", () => {
  it("ignore dates, headers and query order", () => {
    const a = req("2026-12-04", "2026-12-11", "a");
    const b = {
      ...req("2027-01-02", "2027-01-05", "b"),
      url: "https://api.duffel.com/air/offer_requests?return_offers=true&supplier_timeout=5000",
    };
    expect(fixturePath("/f", a)).toBe(fixturePath("/f", b));
    expect(JSON.stringify(fixtureKeyMaterial(a))).not.toContain("secret");
  });

  it("include everything else", () => {
    const a = req("2026-12-04", "2026-12-11");
    const b = req("2026-12-04", "2026-12-11");
    (b.body as { data: { passengers: unknown[] } }).data.passengers.push({ type: "adult" });
    expect(fixturePath("/f", a)).not.toBe(fixturePath("/f", b));
  });

  it("collect request dates in order", () => {
    expect(requestDates(req("2026-12-04", "2026-12-11"))).toEqual(["2026-12-04", "2026-12-11"]);
  });
});

describe("shiftDates", () => {
  it("moves each date by the offset of the nearest request date", () => {
    const body = {
      out: "2026-12-04T22:10:00",
      arrive: "2026-12-05T08:00:00",
      back: "2026-12-11T10:00:00",
      checkin: "2026-12-04",
      other: "not a date",
    };
    expect(shiftDates(body, ["2026-12-04", "2026-12-11"], ["2027-03-10", "2027-03-13"])).toEqual({
      out: "2027-03-10T22:10:00",
      arrive: "2027-03-11T08:00:00",
      back: "2027-03-13T10:00:00",
      checkin: "2027-03-10",
      other: "not a date",
    });
  });
});

describe("recording and replay", () => {
  it("round-trips without storing request headers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fixtures-"));
    const record = recordingTransport(
      async () => ({ status: 200, headers: {}, body: { at: "2026-12-04T09:00:00" } }),
      dir,
    );
    await record(req("2026-12-04", "2026-12-11"), AbortSignal.timeout(1000));

    const [sub] = readdirSync(dir);
    expect(sub).toBe("duffel");
    const [file] = readdirSync(join(dir, "duffel"));
    expect(readFileSync(join(dir, "duffel", file!), "utf8")).not.toContain("secret-token");

    const replay = fixtureTransport(dir);
    const res = await replay(req("2027-01-20", "2027-01-27"), AbortSignal.timeout(1000));
    expect(res).toEqual({ status: 200, headers: {}, body: { at: "2027-01-20T09:00:00" } });
  });

  it("keeps per-search IDs unique across replayed dates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fixtures-"));
    const record = recordingTransport(
      async () => ({ status: 200, headers: {}, body: { id: "off_abc", owner: "arl_x" } }),
      dir,
    );
    await record(req("2026-12-04", "2026-12-11"), AbortSignal.timeout(1000));
    const replay = fixtureTransport(dir);
    const a = await replay(req("2027-01-20", "2027-01-27"), AbortSignal.timeout(1000));
    const b = await replay(req("2027-01-21", "2027-01-28"), AbortSignal.timeout(1000));
    expect(a.body).toEqual({ id: "off_abc2027012020270127", owner: "arl_x" });
    expect((a.body as { id: string }).id).not.toBe((b.body as { id: string }).id);
  });

  it("answers 404 for a missing fixture and says what to record", async () => {
    const logs: string[] = [];
    const replay = fixtureTransport(mkdtempSync(join(tmpdir(), "fixtures-")), (m) => logs.push(m));
    expect((await replay(req("2026-12-04", "2026-12-11"), AbortSignal.timeout(1000))).status).toBe(
      404,
    );
    expect(logs[0]).toContain("fixture recorder");
  });
});

describe("live recordings", () => {
  it("skip error responses so they can't replace good fixtures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fixtures-"));
    const skipped: number[] = [];
    const record = recordingTransport(
      async () => ({ status: 403, headers: {}, body: { errors: [{ message: "not enabled" }] } }),
      dir,
      false,
      (_req, res) => void skipped.push(res.status),
    );
    await record(req("2026-12-04", "2026-12-11"), AbortSignal.timeout(1000));
    expect(skipped).toEqual([403]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("take precedence over synthetic fixtures when replaying", async () => {
    const recorded = mkdtempSync(join(tmpdir(), "recorded-"));
    const synthetic = mkdtempSync(join(tmpdir(), "synthetic-"));
    const write = (dir: string, body: unknown) =>
      recordingTransport(
        async () => ({ status: 200, headers: {}, body }),
        dir,
        dir === synthetic,
      )(req("2026-12-04", "2026-12-11"), AbortSignal.timeout(1000));
    await write(synthetic, { from: "synthetic" });
    const replay = fixtureTransport([recorded, synthetic]);
    expect((await replay(req("2026-12-04", "2026-12-11"), AbortSignal.timeout(1000))).body).toEqual(
      { from: "synthetic" },
    );
    await write(recorded, { from: "recorded" });
    expect((await replay(req("2026-12-04", "2026-12-11"), AbortSignal.timeout(1000))).body).toEqual(
      { from: "recorded" },
    );
  });
});
