import { createHash } from "node:crypto";
import { cityById, PrefetchRequest, toRouteSchema } from "@travellite/schema";
import type { FastifyInstance } from "fastify";
import type { Deps } from "../deps.js";
import { HttpError } from "../errors.js";
import { keys } from "../store/keys.js";

/** Identical prefetches within this window are warmed once across all instances. */
const DEDUPE_SECONDS = 60;

/**
 * Sent while the user is still filling in the form. Warms the flight and hotel caches in the
 * background and returns 202 at once. Never calls the LLM.
 */
export async function prefetchRoutes(app: FastifyInstance, deps: Deps) {
  app.post(
    "/v1/prefetch",
    { config: { rateGroup: "prefetch" }, schema: { body: toRouteSchema(PrefetchRequest) } },
    async (request, reply) => {
      const body = PrefetchRequest.parse(request.body);
      const today = new Date().toISOString().slice(0, 10);
      if (
        !cityById(body.destination) ||
        body.return_date <= body.departure_date ||
        body.departure_date < today
      ) {
        throw new HttpError(400, "INVALID_INPUT", "Invalid trip");
      }

      const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 32);
      const fresh = await deps.redis.set(keys.prefetchLock(hash), "1", "EX", DEDUPE_SECONDS, "NX");
      if (fresh) {
        deps.search
          .prefetch({
            origin: body.origin,
            destination: body.destination,
            depart: body.departure_date,
            return: body.return_date,
            flex_days: body.date_flex_days,
            travelers: body.travelers,
          })
          .catch((err: unknown) => request.log.warn({ err }, "prefetch failed"));
      }
      return reply.code(202).send();
    },
  );
}
