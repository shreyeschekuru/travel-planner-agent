import {
  ApiError,
  ConstraintDelta,
  CreateSessionResponse,
  SavedItinerary,
  type PrefetchRequest,
  type RefineRequest,
  type VacationConfig,
} from "@travellite/schema";
import { z } from "zod";
import type { TokenProvider } from "./install.js";

/** A failed API call, carrying the server's error body when there was one. */
export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.message);
  }
}

const offline: ApiError = {
  code: "NETWORK_ERROR",
  message: "Couldn't reach Travellite. Check your connection.",
  retryable: true,
};

const RefineResponse = z.object({ delta: ConstraintDelta, changed: z.boolean() });

export interface ApiClientDeps {
  apiBase: string;
  token: TokenProvider;
  fetch?: typeof fetch;
}

/** Typed client for the Travellite API. Every call sends the install token. */
export function createApiClient(deps: ApiClientDeps) {
  const fetchFn = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  async function call<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    parse: (v: unknown) => T,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetchFn(`${deps.apiBase}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${await deps.token()}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        throw new ApiCallError(0, offline);
      }
      // A rotated-out or lost token: register again once.
      if (res.status === 401 && attempt === 0) {
        await deps.token.reset();
        continue;
      }
      const text = await res.text();
      const json: unknown = text ? JSON.parse(text) : undefined;
      if (!res.ok) {
        const err = ApiError.safeParse(json);
        throw new ApiCallError(
          res.status,
          err.success
            ? err.data
            : {
                code: "UNKNOWN_ERROR",
                message: "Something went wrong",
                retryable: res.status >= 500,
              },
        );
      }
      return parse(json);
    }
  }

  return {
    eventsUrl: (sessionId: string) => `${deps.apiBase}/v1/sessions/${sessionId}/events`,
    prefetch: (req: PrefetchRequest) => call("POST", "/v1/prefetch", req, () => undefined),
    createSession: (config: VacationConfig) =>
      call("POST", "/v1/sessions", config, (v) => CreateSessionResponse.parse(v)),
    refine: (sessionId: string, body: RefineRequest) =>
      call("POST", `/v1/sessions/${sessionId}/refine`, body, (v) => RefineResponse.parse(v)),
    select: (sessionId: string, packageId: string) =>
      call("POST", `/v1/sessions/${sessionId}/select`, { package_id: packageId }, (v) =>
        SavedItinerary.parse(v),
      ),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
