/**
 * T3Client: the composition root. It wires the HTTP transport, the auth
 * client, the socket transport (ticket or bearer-header upgrade), the RPC
 * connection and typed client, and every facade. The socket opens lazily on
 * the first RPC use and reconnects when the stored credential changes;
 * `close()` stops reconnecting and ends every stream.
 */
import { McpApi } from "./api/mcp.js";
import { ProjectsApi } from "./api/projects.js";
import { ServerApi } from "./api/server.js";
import { ShellApi } from "./api/shell.js";
import { TerminalApi } from "./api/terminal.js";
import { ThreadsApi } from "./api/threads.js";
import { VcsApi } from "./api/vcs.js";
import { CommandDispatcher } from "./api/dispatch.js";
import { AuthClient } from "./auth/auth-client.js";
import { memoryCredentialStore, type CredentialStore } from "./auth/credential-store.js";
import { T3AuthError, T3PreconditionError } from "./errors.js";
import type { Logger } from "./internal/logger.js";
import type { WebSocketConstructor } from "./internal/websocket.js";
import { RpcClient } from "./rpc/client.js";
import { rpcMethods, type RpcMethods } from "./rpc/registry.js";
import { HttpTransport } from "./transport/http.js";
import { RpcConnection } from "./transport/rpc-connection.js";
import { SocketTransport } from "./transport/socket.js";

export interface T3ClientOptions {
  readonly baseUrl: string;
  /** Defaults to an in-memory store. */
  readonly credentials?: CredentialStore;
  /** Convenience: seeds a fresh in-memory store. Not combined with `credentials`. */
  readonly accessToken?: string;
  readonly clientLabel?: string;
  /** Sent as `clientAppVersion` on the socket upgrade. */
  readonly clientAppVersion?: string;
  readonly fetch?: typeof fetch;
  readonly webSocket?: WebSocketConstructor;
  readonly logger?: Logger;
  /** "ticket" (default) works with every WebSocket implementation. */
  readonly socketAuth?: "ticket" | "bearer-header";
}

export class T3Client {
  readonly auth: AuthClient;
  readonly server: ServerApi;
  readonly projects: ProjectsApi;
  readonly threads: ThreadsApi;
  readonly shell: ShellApi;
  readonly mcp: McpApi;
  readonly vcs: VcsApi;
  readonly terminal: TerminalApi;
  readonly rpc: RpcClient<RpcMethods>;
  readonly #socket: SocketTransport;
  readonly #connection: RpcConnection;

  private constructor(options: T3ClientOptions) {
    if (options.credentials && options.accessToken !== undefined) {
      throw new T3PreconditionError("Pass either credentials or accessToken, not both.");
    }
    const credentials =
      options.credentials ??
      memoryCredentialStore(
        options.accessToken === undefined ? {} : { accessToken: options.accessToken },
      );
    const http = new HttpTransport({
      baseUrl: options.baseUrl,
      getAccessToken: () => this.auth.currentAccessToken(),
      userAgent: userAgent(options),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    this.auth = new AuthClient(http, credentials);

    const socketAuth = options.socketAuth ?? "ticket";
    this.#socket = new SocketTransport({
      // Every attempt loads the credential, which also primes `auth.scopesSync()`.
      url: async () => {
        const url = socketUrl(options);
        if (socketAuth === "ticket") {
          const { ticket } = await this.auth.websocketTicket();
          url.searchParams.set("wsTicket", ticket);
        }
        return url;
      },
      ...(socketAuth === "bearer-header" ? { headers: () => this.#bearerHeaders() } : {}),
      ...(options.webSocket === undefined ? {} : { webSocket: options.webSocket }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    this.auth.onCredentialsChange(() => this.#socket.reconnect());
    this.#connection = new RpcConnection(this.#socket, {
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    this.rpc = new RpcClient(this.#connection, rpcMethods, {
      getScopes: () => this.auth.scopesSync(),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });

    const dispatcher = new CommandDispatcher(this.rpc, http);
    this.server = new ServerApi(this.rpc, http);
    this.projects = new ProjectsApi(http, this.rpc, dispatcher);
    this.threads = new ThreadsApi(http, this.rpc, dispatcher);
    this.shell = new ShellApi(http, this.rpc);
    this.mcp = new McpApi(http);
    this.vcs = new VcsApi(this.rpc);
    this.terminal = new TerminalApi(this.rpc);
  }

  static create(options: T3ClientOptions): T3Client {
    return new T3Client(options);
  }

  /** Optional eager connect; every RPC connects on demand otherwise. */
  connect(signal?: AbortSignal): Promise<void> {
    return this.#socket.connect(signal);
  }

  /** Stops reconnecting, fails everything in flight, and closes the socket. */
  close(): Promise<void> {
    return this.#connection.close();
  }

  /**
   * Bearer-header upgrade headers. A WebSocket implementation without upgrade
   * status reporting (the global one) shows a 401 upgrade as an ordinary drop,
   * which would retry forever; validating the token over HTTP first turns a
   * dead credential into a fatal `open_failed` instead.
   */
  async #bearerHeaders(): Promise<Record<string, string>> {
    const token = await this.auth.currentAccessToken();
    if (token === undefined) {
      throw socketAuthError("missing_credential", "The socket upgrade needs an access token.");
    }
    const state = await this.auth.sessionState();
    if (!state.authenticated) {
      throw socketAuthError("invalid_credential", "The access token does not authenticate.");
    }
    return { authorization: `Bearer ${token}` };
  }
}

function socketAuthError(reason: string, message: string): T3AuthError {
  return new T3AuthError(message, {
    code: "auth_invalid",
    status: 401,
    method: "GET",
    path: "/ws",
    body: undefined,
    reason,
  });
}

function socketUrl(options: T3ClientOptions): URL {
  let url: URL;
  try {
    url = new URL("/ws", options.baseUrl);
  } catch (cause) {
    throw new T3PreconditionError(`baseUrl is not a valid URL: ${options.baseUrl}`, { cause });
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("clientSurface", "cli");
  if (options.clientAppVersion !== undefined) {
    url.searchParams.set("clientAppVersion", options.clientAppVersion);
  }
  return url;
}

function userAgent(options: T3ClientOptions): string {
  const version = options.clientAppVersion === undefined ? "" : `/${options.clientAppVersion}`;
  const label = options.clientLabel === undefined ? "" : ` (${options.clientLabel})`;
  return `t3code-client${version}${label}`;
}
