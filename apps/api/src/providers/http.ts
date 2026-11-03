export interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  /** Sent as JSON. */
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  /** Only the headers adapters use (lowercased). */
  headers: Record<string, string>;
  /** Parsed JSON, or the raw text for non-JSON responses. */
  body: unknown;
}

/** Everything that reaches the network goes through a Transport, so tests and fixture mode can swap it. */
export type Transport = (req: HttpRequest, signal: AbortSignal) => Promise<HttpResponse>;

const KEPT_HEADERS = ["retry-after", "content-type"];

/** Live transport. Node's fetch keeps connections alive by default. */
export const fetchTransport: Transport = async (req, signal) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: {
      ...(req.body === undefined ? {} : { "content-type": "application/json" }),
      ...req.headers,
    },
    ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
    signal,
  });
  const headers: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = res.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  const text = await res.text();
  let body: unknown = text;
  if (headers["content-type"]?.includes("json") && text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, headers, body };
};
