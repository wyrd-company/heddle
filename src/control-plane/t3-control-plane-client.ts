// ---
// relationships:
//   implements: heddle
//   references: t3-headless
// ---

import { URL } from "node:url";

import {
  resolveT3AwarenessPhase,
  type T3AwarenessPhase,
  type T3ShellThread,
} from "./t3-agent-awareness.js";
import {
  assertT3ProviderDispatchPreconditions,
  type T3ProviderDispatchContext,
} from "./t3-provider-preconditions.js";
import type {
  T3ProviderCatalog,
  T3ProviderCatalogEntry,
  T3ProviderCatalogModel,
  T3ProviderCatalogReader,
} from "./provider-selection.js";

export {
  resolveT3AwarenessPhase,
  type T3AwarenessPhase,
  type T3ShellThread,
} from "./t3-agent-awareness.js";
export {
  T3ProviderPreconditionError,
  type T3ProviderDispatchContext,
  type T3ProviderPreconditionReason,
  type T3SessionLifecycle,
} from "./t3-provider-preconditions.js";

export type T3ShellSnapshot = {
  threads: T3ShellThread[];
  [key: string]: unknown;
};

export type T3ThreadActivity = {
  kind: string;
  payload?: { requestId?: string; [key: string]: unknown };
  [key: string]: unknown;
};

export type T3UserInputQuestion = {
  header?: string;
  id: string;
  multiSelect: boolean;
  options: Array<{
    description?: string;
    label: string;
  }>;
  question: string;
};

export type T3ThreadSnapshot = {
  snapshotSequence?: number;
  thread: {
    activities?: T3ThreadActivity[];
    [key: string]: unknown;
  };
};

export type T3DispatchCommand = {
  type: string;
  commandId: string;
  threadId?: string;
  projectId?: string;
  requestId?: string;
  [key: string]: unknown;
};

export type T3TokenExchange = {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
};

export type T3WorkflowMcpProviderSession = {
  authorizationHeader: string;
  endpoint: string;
  threadId: string;
};

export type T3ThreadObservation = {
  phase: T3AwarenessPhase;
  thread: T3ShellThread;
};

export class T3PreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "T3PreconditionError";
  }
}

export class T3HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "T3HttpError";
  }
}

export class T3ProviderCatalogReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "T3ProviderCatalogReadError";
  }
}

export type T3WebSocketConstructor = new (
  url: string | URL,
  protocols?: string | string[],
) => InstanceType<typeof globalThis.WebSocket>;

export type T3ControlPlaneClientOptions = {
  baseUrl: string;
  accessToken?: string;
  catalogTimeoutMilliseconds?: number;
  fetch?: typeof globalThis.fetch;
  webSocket?: T3WebSocketConstructor;
};

type FetchRequestInit = NonNullable<Parameters<typeof globalThis.fetch>[1]>;
type FetchAbortSignal = NonNullable<FetchRequestInit["signal"]>;

const requireCatalogString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new T3ProviderCatalogReadError(
      `T3 server.getConfig returned an invalid ${field}`,
    );
  }
  return value;
};

const releasedDispatchFailureDetail = (
  path: string,
  status: number,
  body: unknown,
): string | undefined => {
  if (
    path !== "/api/orchestration/dispatch" ||
    status !== 500 ||
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body)
  ) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "_tag,code,reason,traceId" ||
    record["_tag"] !== "EnvironmentInternalError" ||
    record["code"] !== "internal_error" ||
    record["reason"] !== "orchestration_dispatch_failed" ||
    typeof record["traceId"] !== "string" ||
    record["traceId"].trim() === "" ||
    record["traceId"].trim() !== record["traceId"]
  ) {
    return undefined;
  }
  return `; reason orchestration_dispatch_failed; trace ID ${JSON.stringify(record["traceId"])}`;
};

const projectCatalogModel = (value: unknown): T3ProviderCatalogModel => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new T3ProviderCatalogReadError(
      "T3 server.getConfig returned an invalid provider model",
    );
  }
  const model = value as Record<string, unknown>;
  if (typeof model["isCustom"] !== "boolean") {
    throw new T3ProviderCatalogReadError(
      "T3 server.getConfig returned an invalid provider model custom flag",
    );
  }
  return {
    isCustom: model["isCustom"],
    name: requireCatalogString(model["name"], "provider model name"),
    slug: requireCatalogString(model["slug"], "provider model slug"),
  };
};

const projectCatalogEntry = (value: unknown): T3ProviderCatalogEntry => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new T3ProviderCatalogReadError(
      "T3 server.getConfig returned an invalid provider",
    );
  }
  const provider = value as Record<string, unknown>;
  if (
    typeof provider["enabled"] !== "boolean" ||
    typeof provider["installed"] !== "boolean" ||
    !Array.isArray(provider["models"]) ||
    (provider["availability"] !== undefined &&
      provider["availability"] !== "available" &&
      provider["availability"] !== "unavailable") ||
    (provider["displayName"] !== undefined &&
      typeof provider["displayName"] !== "string") ||
    (provider["version"] !== null &&
      provider["version"] !== undefined &&
      typeof provider["version"] !== "string")
  ) {
    throw new T3ProviderCatalogReadError(
      "T3 server.getConfig returned an invalid provider catalog entry",
    );
  }
  return {
    availability:
      provider["availability"] === "unavailable" ? "unavailable" : "available",
    ...(provider["displayName"] === undefined
      ? {}
      : {
          displayName: requireCatalogString(
            provider["displayName"],
            "provider display name",
          ),
        }),
    driverKind: requireCatalogString(provider["driver"], "provider driver"),
    enabled: provider["enabled"],
    installed: provider["installed"],
    instanceId: requireCatalogString(
      provider["instanceId"],
      "provider instance ID",
    ),
    models: provider["models"].map(projectCatalogModel),
    observedCliVersion:
      provider["version"] === undefined ? null : provider["version"],
    state: requireCatalogString(provider["status"], "provider state"),
  };
};

const projectProviderCatalog = (value: unknown): T3ProviderCatalog => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new T3ProviderCatalogReadError(
      "T3 server.getConfig returned an invalid configuration",
    );
  }
  const providers = (value as Record<string, unknown>)["providers"];
  if (!Array.isArray(providers)) {
    throw new T3ProviderCatalogReadError(
      "T3 server.getConfig returned no provider catalog",
    );
  }
  return providers.map(projectCatalogEntry);
};

export class T3ControlPlaneClient implements T3ProviderCatalogReader {
  readonly #baseUrl: string;
  readonly #catalogTimeoutMilliseconds: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #webSocket: T3WebSocketConstructor;
  #accessToken?: string;

  constructor(options: T3ControlPlaneClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#accessToken = options.accessToken;
    this.#catalogTimeoutMilliseconds =
      options.catalogTimeoutMilliseconds ?? 10_000;
    if (
      !Number.isSafeInteger(this.#catalogTimeoutMilliseconds) ||
      this.#catalogTimeoutMilliseconds <= 0
    ) {
      throw new T3PreconditionError(
        "Provider catalog timeout must be a positive safe integer",
      );
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#webSocket = options.webSocket ?? globalThis.WebSocket;
  }

  async exchangePairingToken(
    pairingToken: string,
    clientLabel: string,
  ): Promise<T3TokenExchange> {
    if (pairingToken.length === 0)
      throw new T3PreconditionError("Pairing token must not be empty");
    if (clientLabel.length === 0)
      throw new T3PreconditionError("Client label must not be empty");

    const body = new globalThis.URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: pairingToken,
      subject_token_type:
        "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: clientLabel,
    });
    const token = await this.#request<T3TokenExchange>("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!token.access_token)
      throw new T3HttpError(
        "T3 token exchange returned no access token",
        200,
        token,
      );
    this.#accessToken = token.access_token;
    return token;
  }

  async getShell(): Promise<T3ShellSnapshot> {
    this.#requireAccessToken("read the orchestration shell");
    return this.#request<T3ShellSnapshot>("/api/orchestration/shell");
  }

  async readProviderCatalog(): Promise<T3ProviderCatalog> {
    this.#requireAccessToken("read the provider catalog");
    const ticket = await this.#request<{ ticket?: unknown }>(
      "/api/auth/websocket-ticket",
      {
        method: "POST",
        signal: globalThis.AbortSignal.timeout(
          this.#catalogTimeoutMilliseconds,
        ),
      },
    );
    const ticketValue = requireCatalogString(ticket.ticket, "WebSocket ticket");
    const socketUrl = new URL(this.#baseUrl);
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    socketUrl.pathname = "/ws";
    socketUrl.search = "";
    socketUrl.hash = "";
    socketUrl.searchParams.set("wsTicket", ticketValue);
    const socket = new this.#webSocket(socketUrl);
    const requestId = globalThis.crypto.randomUUID();
    try {
      const config = await new Promise<unknown>((resolve, reject) => {
        const finish = (result: () => void): void => {
          globalThis.clearTimeout(timer);
          socket.removeEventListener("open", onOpen);
          socket.removeEventListener("message", onMessage);
          socket.removeEventListener("error", onError);
          socket.removeEventListener("close", onClose);
          result();
        };
        const onOpen = (): void => {
          socket.send(
            JSON.stringify({
              // T3 decodes `headers` as a required array. Omitting it fails
              // the server-side decode, which closes the socket with no
              // reason rather than returning an error.
              _tag: "Request",
              headers: [],
              id: requestId,
              payload: {},
              tag: "server.getConfig",
            }),
          );
        };
        const onMessage = (
          event: InstanceType<typeof globalThis.MessageEvent>,
        ): void => {
          if (typeof event.data !== "string") {
            finish(() =>
              reject(
                new T3ProviderCatalogReadError(
                  "T3 server.getConfig RPC returned a non-text response",
                ),
              ),
            );
            return;
          }
          let response: unknown;
          try {
            response = JSON.parse(event.data) as unknown;
          } catch {
            finish(() =>
              reject(
                new T3ProviderCatalogReadError(
                  "T3 server.getConfig RPC returned invalid JSON",
                ),
              ),
            );
            return;
          }
          if (
            typeof response !== "object" ||
            response === null ||
            Array.isArray(response)
          ) {
            return;
          }
          const record = response as Record<string, unknown>;
          if (record["_tag"] !== "Exit" || record["requestId"] !== requestId) {
            return;
          }
          const exit = record["exit"];
          if (
            typeof exit !== "object" ||
            exit === null ||
            Array.isArray(exit)
          ) {
            finish(() =>
              reject(
                new T3ProviderCatalogReadError(
                  "T3 server.getConfig RPC returned an invalid result",
                ),
              ),
            );
            return;
          }
          const result = exit as Record<string, unknown>;
          if (result["_tag"] !== "Success") {
            finish(() =>
              reject(
                new T3ProviderCatalogReadError(
                  "T3 server.getConfig RPC did not return a successful provider catalog",
                ),
              ),
            );
            return;
          }
          finish(() => resolve(result["value"]));
        };
        const onError = (): void =>
          finish(() =>
            reject(
              new T3ProviderCatalogReadError(
                "T3 provider catalog WebSocket failed",
              ),
            ),
          );
        const onClose = (): void =>
          finish(() =>
            reject(
              new T3ProviderCatalogReadError(
                "T3 provider catalog WebSocket closed before the RPC completed",
              ),
            ),
          );
        const timer = globalThis.setTimeout(
          () =>
            finish(() =>
              reject(
                new T3ProviderCatalogReadError(
                  `T3 server.getConfig RPC exceeded ${this.#catalogTimeoutMilliseconds}ms`,
                ),
              ),
            ),
          this.#catalogTimeoutMilliseconds,
        );
        socket.addEventListener("open", onOpen);
        socket.addEventListener("message", onMessage);
        socket.addEventListener("error", onError);
        socket.addEventListener("close", onClose);
      });
      return projectProviderCatalog(config);
    } finally {
      if (socket.readyState < globalThis.WebSocket.CLOSING) socket.close();
    }
  }

  async getThread(threadId: string): Promise<T3ThreadSnapshot> {
    this.#requireAccessToken("read a thread snapshot");
    return this.#request<T3ThreadSnapshot>(
      `/api/orchestration/threads/${encodeURIComponent(threadId)}`,
    );
  }

  async observeThread(threadId: string): Promise<T3ThreadObservation> {
    const shell = await this.getShell();
    const thread = shell.threads.find(({ id }) => id === threadId);
    if (!thread)
      throw new T3PreconditionError(
        `Thread '${threadId}' is absent from the T3 shell snapshot`,
      );
    return { thread, phase: resolveT3AwarenessPhase(thread) };
  }

  async *pollThread(
    threadId: string,
    intervalMs = 3_000,
    signal?: FetchAbortSignal,
  ): AsyncGenerator<T3ThreadObservation> {
    if (intervalMs < 0)
      throw new T3PreconditionError("Polling interval must not be negative");
    while (!signal?.aborted) {
      yield await this.observeThread(threadId);
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          globalThis.clearTimeout(timer);
          reject(signal?.reason ?? new Error("Polling aborted"));
        };
        const timer = globalThis.setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, intervalMs);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  async dispatch<T extends { sequence: number } = { sequence: number }>(
    command: T3DispatchCommand,
    providerContext?: T3ProviderDispatchContext,
  ): Promise<T> {
    this.#requireAccessToken(`dispatch '${command.type}'`);
    if (command.type === "thread.turn.start") {
      if (!command.threadId)
        throw new T3PreconditionError(
          "Dispatch 'thread.turn.start' requires threadId",
        );
      assertT3ProviderDispatchPreconditions(
        providerContext,
        command.runtimeMode,
        this.#selectedProviderInstanceId(command.modelSelection),
      );
    }
    await this.#checkDispatchPreconditions(command);
    return this.#request<T>("/api/orchestration/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    });
  }

  async registerWorkflowMcpProviderSession(
    registration: T3WorkflowMcpProviderSession,
  ): Promise<void> {
    this.#requireAccessToken("register a workflow MCP provider session");
    await this.#request<void>("/api/mcp/provider-session", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(registration),
    });
  }

  #selectedProviderInstanceId(modelSelection: unknown): unknown {
    if (typeof modelSelection !== "object" || modelSelection === null)
      return undefined;
    if (!("instanceId" in modelSelection)) return undefined;
    return modelSelection.instanceId;
  }

  async respondToApproval(
    threadId: string,
    requestId: string,
    decision: "accept" | "reject",
    commandId = globalThis.crypto.randomUUID(),
  ): Promise<{ sequence: number }> {
    return this.dispatch({
      type: "thread.approval.respond",
      commandId,
      threadId,
      requestId,
      decision: decision === "reject" ? "decline" : decision,
      createdAt: new Date().toISOString(),
    });
  }

  async respondToUserInput(
    threadId: string,
    requestId: string,
    answers: Record<string, string | string[]>,
    commandId = globalThis.crypto.randomUUID(),
  ): Promise<{ sequence: number }> {
    return this.dispatch({
      type: "thread.user-input.respond",
      commandId,
      threadId,
      requestId,
      answers,
      createdAt: new Date().toISOString(),
    });
  }

  async #checkDispatchPreconditions(command: T3DispatchCommand): Promise<void> {
    const threadCommands = new Set([
      "thread.turn.start",
      "thread.turn.interrupt",
      "thread.session.stop",
      "thread.approval.respond",
      "thread.user-input.respond",
    ]);
    if (!threadCommands.has(command.type)) return;
    if (!command.threadId)
      throw new T3PreconditionError(
        `Dispatch '${command.type}' requires threadId`,
      );

    const shell = await this.getShell();
    const shellThread = shell.threads.find(({ id }) => id === command.threadId);
    if (!shellThread)
      throw new T3PreconditionError(
        `Cannot dispatch '${command.type}': thread '${command.threadId}' does not exist`,
      );

    const requestKind =
      command.type === "thread.approval.respond"
        ? "approval.requested"
        : command.type === "thread.user-input.respond"
          ? "user-input.requested"
          : undefined;
    if (!requestKind) return;
    if (!command.requestId)
      throw new T3PreconditionError(
        `Dispatch '${command.type}' requires requestId`,
      );
    const requestIsPending =
      command.type === "thread.approval.respond"
        ? shellThread.hasPendingApprovals
        : shellThread.hasPendingUserInput;
    if (!requestIsPending)
      throw new T3PreconditionError(
        `Cannot dispatch '${command.type}': thread '${command.threadId}' has no pending request of the required kind`,
      );

    const snapshot = await this.getThread(command.threadId);
    const latestRequestedId = snapshot.thread.activities
      ?.filter(({ kind }) => kind === requestKind)
      .at(-1)?.payload?.requestId;
    if (latestRequestedId !== command.requestId)
      throw new T3PreconditionError(
        `Cannot dispatch '${command.type}': pending request '${command.requestId}' does not exist on thread '${command.threadId}'`,
      );
  }

  #requireAccessToken(operation: string): void {
    if (!this.#accessToken)
      throw new T3PreconditionError(
        `Cannot ${operation}: no T3 access token is configured`,
      );
  }

  async #request<T>(path: string, init: FetchRequestInit = {}): Promise<T> {
    const headers = new globalThis.Headers(init.headers);
    if (this.#accessToken)
      headers.set("authorization", `Bearer ${this.#accessToken}`);
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers,
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text.length === 0 ? undefined : JSON.parse(text);
    } catch {
      body = text;
    }
    if (!response.ok)
      throw new T3HttpError(
        `T3 ${init.method ?? "GET"} ${path} failed with HTTP ${response.status}${releasedDispatchFailureDetail(path, response.status, body) ?? ""}`,
        response.status,
        body,
      );
    return body as T;
  }
}
