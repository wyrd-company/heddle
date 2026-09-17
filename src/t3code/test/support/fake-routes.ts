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
