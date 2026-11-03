import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", { config: { auth: false } }, async () => ({ status: "ok" as const }));
}
