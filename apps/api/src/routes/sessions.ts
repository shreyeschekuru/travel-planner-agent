import { randomUUID } from "node:crypto";
import {
  cityById,
  parseVacationConfig,
  SavedItinerary,
  SelectRequest,
  toRouteSchema,
  VacationConfigShape,
  type CreateSessionResponse,
  type Option,
  type SessionRecord,
} from "@travellite/schema";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { isAllowedExtensionOrigin } from "../auth/origin.js";
import { buildConstraints } from "../core/constraints.js";
import type { Deps } from "../deps.js";
import { HttpError } from "../errors.js";
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
    if (session.status === "searching") deps.runner.start(id);

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
