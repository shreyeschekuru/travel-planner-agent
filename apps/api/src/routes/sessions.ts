import { randomUUID } from "node:crypto";
import {
  cityById,
  parseVacationConfig,
  MAX_REFINEMENTS,
  RefineRequest,
  SavedItinerary,
  SelectRequest,
  toRouteSchema,
  VacationConfigShape,
  type ConstraintDelta,
  type CreateSessionResponse,
  type HotelOption,
  type RefineRequest as RefineBody,
  type Option,
  type SessionRecord,
} from "@travellite/schema";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { isAllowedExtensionOrigin } from "../auth/origin.js";
import { buildConstraints } from "../core/constraints.js";
import { applyDelta, chipDelta, type ChipContext } from "../core/deltas.js";
import { hotelPasses, hotelTotal } from "../core/optimizer.js";
import type { Deps } from "../deps.js";
import { HttpError } from "../errors.js";
import { parseDelta } from "../llm/parse-delta.js";
import { isAllowedBookingUrl } from "../providers/normalize.js";
import type { StoredEvent } from "../store/events.js";
import { keys } from "../store/keys.js";

const STREAM_ID = /^\d{1,20}-\d{1,20}$/;
const Params = z.object({ id: z.uuid() });

const notFound = () => new HttpError(404, "NOT_FOUND", "Session not found");

function sessionId(request: FastifyRequest): string {
  const parsed = Params.safeParse(request.params);
  if (!parsed.success) throw notFound();
  return parsed.data.id;
}

function sseFrame({ id, event }: StoredEvent): string {
  return `id: ${id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/**
 * Hotel prices the chips compare against: the cheapest shown (or, with no packages, in the
 * results), and every result that passes the other hotel constraints.
 */
async function hotelPrices(deps: Deps, session: SessionRecord): Promise<ChipContext> {
  const perNight = (h: HotelOption) => hotelTotal(h) / h.attrs.nights;
  const ids = session.results.hotel?.option_ids ?? [];
  const hotels = [...(await deps.cache.getOptions(ids)).values()].filter(
    (o): o is HotelOption => o.category === "hotel",
  );
  const uncapped = { ...session.constraints, hotel: { ...session.constraints.hotel } };
  delete uncapped.hotel.max_price_per_night_usd;
  const eligiblePerNight = hotels.filter((h) => hotelPasses(h, uncapped)).map(perNight);
  const shown = session.packages.map((p) => perNight(p.hotel));
  const pool = shown.length ? shown : hotels.map(perNight);
  return {
    ...(pool.length ? { hotelPerNight: Math.min(...pool) } : {}),
    ...(hotels.length ? { eligiblePerNight } : {}),
  };
}

/** Turns a chip or text into a delta, applies it, and starts the rerun when anything changed. */
async function refineSession(
  deps: Deps,
  id: string,
  installId: string,
  body: RefineBody,
): Promise<{ delta: ConstraintDelta; changed: boolean }> {
  const session = await deps.sessions.getOwned(id, installId);
  if (!session) throw notFound();
  if (session.status !== "awaiting_selection") {
    throw new HttpError(400, "INVALID_INPUT", "Still working on your last change", true);
  }
  if (session.delta_history.length >= MAX_REFINEMENTS) {
    throw new HttpError(
      400,
      "INVALID_INPUT",
      `You can refine a trip up to ${MAX_REFINEMENTS} times`,
    );
  }

  const prices = await hotelPrices(deps, session);
  const hotelPerNight = prices.hotelPerNight;
  let delta: ConstraintDelta | null;
  if ("chip" in body) {
    delta = chipDelta(body.chip, session.constraints, prices);
    if (!delta) {
      const message =
        body.chip === "cheaper_hotel"
          ? "No cheaper hotels for these dates"
          : "That option isn't available for this trip";
      throw new HttpError(400, "INVALID_INPUT", message);
    }
  } else {
    const parsed = await parseDelta(deps.llm, body.text, session.constraints, {
      today: new Date().toISOString().slice(0, 10),
      ...(hotelPerNight === undefined ? {} : { hotel_per_night: Math.round(hotelPerNight) }),
    });
    if (!parsed.ok) throw new HttpError(400, "INVALID_INPUT", "Couldn't apply that, try a chip");
    delta = parsed.delta;
  }

  const applied = applyDelta(session.constraints, delta);
  if (!applied.ok) throw new HttpError(400, "INVALID_INPUT", applied.error);
  if (applied.changed) {
    await deps.sessions.put({
      ...session,
      constraints: applied.constraints,
      delta_history: [...session.delta_history, delta],
      status: "refining",
    });
  }
  // The client shows the reason either way; an unchanged delta keeps the current packages.
  await deps.events.append(id, {
    event: "refine_applied",
    data: { delta, changed: applied.changed },
  });
  if (applied.changed) deps.runner.start(id);
  return { delta, changed: applied.changed };
}

export async function sessionRoutes(app: FastifyInstance, deps: Deps) {
  // Open event streams never finish on their own, so shutdown ends them; clients reconnect
  // to another instance with Last-Event-ID.
  const openStreams = new Set<() => void>();
  app.addHook("preClose", async () => {
    for (const close of openStreams) close();
  });

  app.post(
    "/v1/sessions",
    { config: { rateGroup: "sessions" }, schema: { body: toRouteSchema(VacationConfigShape) } },
    async (request, reply): Promise<CreateSessionResponse> => {
      const parsed = parseVacationConfig(request.body);
      if (!parsed.success || !cityById(parsed.data.destination)) {
        throw new HttpError(400, "INVALID_INPUT", "Invalid trip");
      }
      const config = parsed.data;
      const record: SessionRecord = {
        id: randomUUID(),
        install_id: request.installId,
        status: "searching",
        config,
        constraints: buildConstraints(config),
        delta_history: [],
        results: {},
        packages: [],
        explanations: [],
        created_at: new Date().toISOString(),
      };
      await deps.sessions.put(record);
      deps.runner.start(record.id);
      reply.code(201);
      return { session_id: record.id, stream_url: `/v1/sessions/${record.id}/events` };
    },
  );

  /**
   * Server-sent events, replayed from the Redis stream after Last-Event-ID (or from the start),
   * then live. Any instance can serve any session's stream.
   */
  app.get("/v1/sessions/:id/events", async (request, reply) => {
    const ids = deps.config.EXTENSION_IDS;
    if (ids.length && !isAllowedExtensionOrigin(request.headers.origin, ids)) {
      throw new HttpError(403, "UNAUTHORIZED", "Origin not allowed");
    }
    const id = sessionId(request);
    const session = await deps.sessions.getOwned(id, request.installId);
    if (!session) throw notFound();
    // If the instance running this session stopped, the reconnecting client restarts it.
    if (session.status === "searching" || session.status === "refining") deps.runner.start(id);

    const header = request.headers["last-event-id"];
    const query = (request.query as Record<string, unknown>)?.last_event_id;
    const resumeFrom = [header, query].find(
      (v): v is string => typeof v === "string" && STREAM_ID.test(v),
    );
    let cursor = resumeFrom ?? "0";

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      // Long-lived; not worth reusing, and a reusable socket would hold up shutdown.
      connection: "close",
      "x-accel-buffering": "no",
    });

    // XREAD BLOCK holds a connection, so each stream gets its own.
    const blocking = deps.redis.duplicate();
    let open = true;
    const close = () => {
      open = false;
      blocking.disconnect();
    };
    // The response's close event fires when the client goes away (the request's may not).
    res.on("close", close);
    openStreams.add(close);

    try {
      for (const e of await deps.events.readAfter(id, cursor, 1000)) {
        res.write(sseFrame(e));
        cursor = e.id;
      }
      while (open) {
        const batch = await deps.events.tail(blocking, id, cursor, deps.sseHeartbeatMs);
        if (!open) break;
        if (batch.length === 0) {
          // Selected or expired sessions end the stream.
          if (!(await deps.redis.exists(keys.session(id)))) break;
          res.write(": keep-alive\n\n");
          continue;
        }
        for (const e of batch) {
          res.write(sseFrame(e));
          cursor = e.id;
        }
      }
    } catch (err) {
      if (open) request.log.warn({ err }, "event stream failed");
    } finally {
      openStreams.delete(close);
      blocking.disconnect();
      res.end();
    }
  });

  app.post(
    "/v1/sessions/:id/refine",
    { config: { rateGroup: "refine" }, schema: { body: toRouteSchema(RefineRequest) } },
    async (request, reply) => {
      const sid = sessionId(request);
      const body = RefineRequest.parse(request.body);
      const lockKey = keys.refineLock(sid);
      // One refinement at a time per session, even across instances.
      if (!(await deps.redis.set(lockKey, "1", "PX", 15_000, "NX"))) {
        throw new HttpError(400, "INVALID_INPUT", "Still working on your last change", true);
      }
      try {
        const result = await refineSession(deps, sid, request.installId, body);
        reply.code(202);
        return result;
      } finally {
        await deps.redis.del(lockKey);
      }
    },
  );

  app.post(
    "/v1/sessions/:id/select",
    { config: { rateGroup: "refine" }, schema: { body: toRouteSchema(SelectRequest) } },
    async (request) => {
      const id = sessionId(request);
      const { package_id } = SelectRequest.parse(request.body);
      const session = await deps.sessions.getOwned(id, request.installId);
      if (!session) throw notFound();
      if (session.status !== "awaiting_selection") {
        throw new HttpError(400, "INVALID_INPUT", "This trip isn't ready to select yet");
      }
      const pkg = session.packages.find((p) => p.id === package_id);
      if (!pkg) throw new HttpError(400, "INVALID_INPUT", "Unknown package");

      // Links come from the server's option store, falling back to the session's own copy;
      // never from the client.
      const chosen: Option[] = [pkg.flight, pkg.hotel, ...pkg.activities];
      const stored = await deps.cache.getOptions(chosen.map((o) => o.id));
      const link = (o: Option, summary: string) => {
        const url = stored.get(o.id)?.url ?? o.url;
        if (!isAllowedBookingUrl(url)) throw new Error(`booking URL not allowlisted for ${o.id}`);
        return { url, summary: summary.slice(0, 200) };
      };
      const f = pkg.flight.attrs;
      const itinerary = SavedItinerary.parse({
        session_id: id,
        package_label: pkg.label,
        destination: session.config.destination,
        dates: { departure: pkg.hotel.attrs.checkin, return: pkg.hotel.attrs.checkout },
        selections: {
          flight: link(
            pkg.flight,
            `${pkg.flight.title}, departs ${f.depart_at.replace("T", " ").slice(0, 16)}`,
          ),
          hotel: link(pkg.hotel, `${pkg.hotel.title}, ${pkg.hotel.attrs.nights} nights`),
          activities: pkg.activities.map((a) => link(a, a.title)),
        },
        total_usd: pkg.total_usd,
        created_at: new Date().toISOString(),
        status: "saved",
      });

      // Deleting the record is the claim: of two concurrent selects, only one gets a 200.
      if ((await deps.redis.del(keys.session(id))) === 0) throw notFound();
      await deps.events.delete(id);
      return itinerary;
    },
  );
}
