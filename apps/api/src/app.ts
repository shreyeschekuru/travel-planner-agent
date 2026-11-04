import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { bearerToken } from "./auth/install-token.js";
import type { Deps } from "./deps.js";
import { HttpError } from "./errors.js";
import type { RateGroup } from "./limits/rate-limit.js";
import { healthRoutes } from "./routes/health.js";
import { installRoutes } from "./routes/install.js";
import { prefetchRoutes } from "./routes/prefetch.js";
import { sessionRoutes } from "./routes/sessions.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Defaults to true. Set false for public routes. */
    auth?: boolean;
    rateGroup?: RateGroup;
  }
  interface FastifyRequest {
    installId: string;
  }
}

export interface AppOptions {
  logger?: boolean;
  /** Set when running behind a load balancer so request.ip is the client IP. */
  trustProxy?: boolean;
  /** Destroy every open connection on close instead of only idle ones. */
  forceCloseConnections?: boolean;
}

export async function buildApp(deps: Deps, opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: opts.trustProxy ?? false,
    forceCloseConnections: opts.forceCloseConnections ?? "idle",
    bodyLimit: 16 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });

  app.decorateRequest("installId", "");

  app.addHook("onRequest", async (request) => {
    // Unmatched routes fall through to the 404 handler.
    if (!request.routeOptions.url || request.routeOptions.config.auth === false) return;
    const token = bearerToken(request.headers.authorization);
    const claims = token ? deps.tokens.verify(token) : null;
    if (!claims) throw new HttpError(401, "UNAUTHORIZED", "Missing or invalid install token");
    request.installId = claims.iid;
  });

  app.addHook("preHandler", async (request) => {
    const group = request.routeOptions.config.rateGroup;
    if (!group) return;
    const decision = await deps.rateLimiter.check(group, {
      ip: request.ip,
      ...(request.installId ? { token: request.installId } : {}),
    });
    if (!decision.allowed) {
      throw new HttpError(429, "RATE_LIMITED", "Too many requests", true, {
        "retry-after": String(decision.retryAfterSeconds),
      });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.status).headers(error.headers).send(error.toBody());
    }
    const e = error as { validation?: unknown; statusCode?: number };
    if (error instanceof ZodError || e.validation || e.statusCode === 400 || e.statusCode === 415) {
      return reply
        .code(400)
        .send({ code: "INVALID_INPUT", message: "Invalid request", retryable: false });
    }
    if (e.statusCode === 413) {
      return reply
        .code(413)
        .send({ code: "INVALID_INPUT", message: "Request too large", retryable: false });
    }
    request.log.error({ err: error }, "unhandled error");
    return reply
      .code(500)
      .send({ code: "UNKNOWN_ERROR", message: "Something went wrong", retryable: true });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ code: "NOT_FOUND", message: "Not found", retryable: false }),
  );

  await app.register(healthRoutes);
  await app.register(async (scope) => installRoutes(scope, deps));
  await app.register(async (scope) => prefetchRoutes(scope, deps));
  await app.register(async (scope) => sessionRoutes(scope, deps));
  return app;
}
