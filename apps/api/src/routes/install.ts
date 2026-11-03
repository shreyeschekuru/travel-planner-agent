import { InstallRequest, toRouteSchema, type InstallResponse } from "@travellite/schema";
import type { FastifyInstance } from "fastify";
import type { Deps } from "../deps.js";

export async function installRoutes(app: FastifyInstance, deps: Deps) {
  app.post(
    "/v1/install",
    {
      config: { auth: false, rateGroup: "install" },
      schema: { body: toRouteSchema(InstallRequest) },
    },
    async (request, reply): Promise<InstallResponse> => {
      InstallRequest.parse(request.body);
      const { token } = deps.tokens.issue();
      reply.code(201);
      return { install_token: token };
    },
  );
}
