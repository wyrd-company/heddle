/**
 * A tiny HTTP route table shared by the fake server (served over a real port)
 * and `createFakeFetch` (served in-process). Keys are `"METHOD /path"`.
 */
export interface FakeHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export interface FakeHttpResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

export type FakeRouteHandler = (
  request: FakeHttpRequest,
) => FakeHttpResponse | Promise<FakeHttpResponse>;

export class FakeRouteTable {
  readonly #routes = new Map<string, FakeRouteHandler>();
  readonly requests: FakeHttpRequest[] = [];

  route(key: `${string} ${string}`, handler: FakeRouteHandler): this {
    this.#routes.set(key, handler);
    return this;
  }

  async dispatch(request: FakeHttpRequest): Promise<FakeHttpResponse> {
    this.requests.push(request);
    const handler = this.#routes.get(`${request.method} ${request.path}`);
    if (!handler) return { status: 404, body: { error: "not_found" } };
    return handler(request);
  }
}

/** A `fetch` that answers from the table without a network. */
export function createFakeFetch(table: FakeRouteTable): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const body = await readBody(await request.text(), headers["content-type"]);
    const response = await table.dispatch({
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      headers,
      body,
    });
    return toResponse(response);
  };
}

export async function readBody(text: string, contentType: string | undefined): Promise<unknown> {
  if (text.length === 0) return undefined;
  if (contentType?.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function toResponse(response: FakeHttpResponse): Response {
  const hasBody = response.body !== undefined && response.status !== 204;
  return new Response(hasBody ? JSON.stringify(response.body) : null, {
    status: response.status,
    headers: { ...(hasBody ? { "content-type": "application/json" } : {}), ...response.headers },
  });
}

export const PROVIDER_SESSION_ROUTE = "GET /api/mcp/provider-session" as const;

/**
 * Answers the fork's provider-session read from a map of thread id to native
 * harness session id: 200 with the exact value, 404 when the thread has no
 * known identity, 400 when the query is malformed.
 */
export function routeProviderSession(
  table: FakeRouteTable,
  sessions: ReadonlyMap<string, string>,
): FakeRouteTable {
  return table.route(PROVIDER_SESSION_ROUTE, (request) => {
    const thread = request.query.get("threadId");
    if (thread === null || thread.length === 0) {
      return { status: 400, body: { error: "invalid_external_mcp_registration" } };
    }
    const nativeSessionId = sessions.get(thread);
    if (nativeSessionId === undefined) return { status: 404, body: { reason: "thread_not_found" } };
    return { status: 200, body: { nativeSessionId } };
  });
}
