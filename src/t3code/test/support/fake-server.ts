/**
 * FakeT3Server: an in-process stand-in for the T3 Code server. It speaks the
 * RPC envelope protocol over `ws`, answers HTTP routes from a `FakeRouteTable`,
 * authenticates the upgrade like the real server (`?wsTicket` or a bearer
 * header), and records everything so tests can assert on it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { FakeConnection } from "./fake-connection.js";
import { FakeRouteTable, createFakeFetch, readBody } from "./fake-routes.js";

export { FakeConnection, type LoggedEnvelope } from "./fake-connection.js";

export type FakeRpcResponse =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "fail"; readonly error: { readonly _tag: string } & Record<string, unknown> }
  | { readonly kind: "die"; readonly defect: unknown }
  | {
      readonly kind: "stream";
      /** Each inner array is sent as one `Chunk`. */
      readonly chunks: readonly (readonly unknown[])[];
      /** How the stream ends after the last chunk. Default: success with `undefined`. */
      readonly exit?: Exclude<FakeRpcResponse, { kind: "stream" | "hang" }>;
    }
  /** Never answers; use with Interrupt or drop tests. */
  | { readonly kind: "hang" };

export interface FakeRequestContext {
  readonly requestId: string;
  readonly connection: FakeConnection;
}

export type FakeRpcHandler = (
  payload: unknown,
  context: FakeRequestContext,
) => FakeRpcResponse | Promise<FakeRpcResponse>;

export interface FakeUpgrade {
  readonly url: URL;
  readonly query: Record<string, string>;
  readonly headers: Record<string, string>;
  readonly accepted: boolean;
}

export interface FakeServerOptions {
  /** Require an `Ack` before the next `Chunk` of a stream is sent. Default true, like the real server. */
  readonly requireAck?: boolean;
  /** Accept only this bearer token (or a ticket from `issueTicket`). Default: accept everything. */
  readonly token?: string;
}

export class FakeT3Server {
  readonly handlers = new Map<string, FakeRpcHandler>();
  readonly routes = new FakeRouteTable();
  readonly upgrades: FakeUpgrade[] = [];
  readonly connections: FakeConnection[] = [];
  readonly tickets = new Set<string>();
  pings = 0;
  requireAck: boolean;
  token: string | undefined;
  readonly #http: Server;
  readonly #wss = new WebSocketServer({ noServer: true });
  #port = 0;

  private constructor(options: FakeServerOptions) {
    this.requireAck = options.requireAck ?? true;
    this.token = options.token;
    this.#http = createServer((req, res) => void this.#onHttp(req, res));
    this.#http.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://fake");
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [
          k,
          Array.isArray(v) ? v.join(",") : (v ?? ""),
        ]),
      );
      const accepted = url.pathname === "/ws" && this.#authorized(url, headers);
      this.upgrades.push({ url, query: Object.fromEntries(url.searchParams), headers, accepted });
      if (!accepted) {
        const body = JSON.stringify({
          _tag: "EnvironmentAuthInvalidError",
          code: "auth_invalid",
          reason: "invalid_credential",
        });
        socket.write(
          `HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
        );
        socket.destroy();
        return;
      }
      this.#wss.handleUpgrade(req, socket, head, (ws) => {
        this.connections.push(new FakeConnection(ws, this));
      });
    });
  }

  static async start(options: FakeServerOptions = {}): Promise<FakeT3Server> {
    const server = new FakeT3Server(options);
    await new Promise<void>((resolve) => server.#http.listen(0, "127.0.0.1", resolve));
    const address = server.#http.address();
    server.#port = typeof address === "object" && address ? address.port : 0;
    return server;
  }

  get httpUrl(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  get wsUrl(): URL {
    return new URL(`ws://127.0.0.1:${this.#port}/ws`);
  }

  /** A `fetch` that answers from `routes` in-process. */
  get fetch(): typeof fetch {
    return createFakeFetch(this.routes);
  }

  get lastConnection(): FakeConnection {
    const last = this.connections.at(-1);
    if (!last) throw new Error("No connection yet.");
    return last;
  }

  handle(tag: string, handler: FakeRpcHandler): this {
    this.handlers.set(tag, handler);
    return this;
  }

  /** Answers `tag` with a plain success value. */
  respond(tag: string, value: unknown): this {
    return this.handle(tag, () => ({ kind: "value", value }));
  }

  issueTicket(): string {
    const ticket = randomUUID();
    this.tickets.add(ticket);
    return ticket;
  }

  /** Resolves once `count` connections have been accepted. */
  async waitForConnections(count: number, timeoutMs = 5_000): Promise<FakeConnection> {
    const started = Date.now();
    while (this.connections.length < count) {
      if (Date.now() - started > timeoutMs)
        throw new Error(`Timed out waiting for connection ${count}.`);
      await new Promise((r) => setTimeout(r, 5));
    }
    return this.connections[count - 1] as FakeConnection;
  }

  dropAll(): void {
    for (const connection of this.connections) connection.drop();
  }

  async close(): Promise<void> {
    this.dropAll();
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.#http.close(() => resolve()));
  }

  #authorized(url: URL, headers: Record<string, string>): boolean {
    if (this.token === undefined) return true;
    const ticket = url.searchParams.get("wsTicket");
    if (ticket && this.tickets.has(ticket)) return true;
    return headers["authorization"] === `Bearer ${this.token}`;
  }

  async #onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : (v ?? "")]),
    );
    const response = await this.routes.dispatch({
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      headers,
      body: await readBody(Buffer.concat(chunks).toString("utf8"), headers["content-type"]),
    });
    const hasBody = response.body !== undefined && response.status !== 204;
    res.writeHead(response.status, {
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...response.headers,
    });
    res.end(hasBody ? JSON.stringify(response.body) : undefined);
  }
}
