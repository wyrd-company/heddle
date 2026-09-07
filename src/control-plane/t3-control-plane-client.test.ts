// ---
// relationships:
//   verifies: t3-control-plane-client
//   references: t3-headless
// ---

import { URL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  resolveT3AwarenessPhase,
  T3ControlPlaneClient,
  T3HttpError,
  T3PreconditionError,
  type T3WebSocketConstructor,
  type T3ShellThread,
} from "./t3-control-plane-client.js";

const jsonResponse = (body: unknown, status = 200) =>
  new globalThis.Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

type SocketEvent =
  | InstanceType<typeof globalThis.Event>
  | InstanceType<typeof globalThis.MessageEvent<string>>;
type SocketListener = (event: SocketEvent) => void;

class CatalogWebSocket {
  public static readonly CONNECTING = 0;
  public static readonly OPEN = 1;
  public static readonly CLOSING = 2;
  public static readonly CLOSED = 3;

  public readonly listeners = new Map<string, Set<SocketListener>>();
  public readonly sent: string[] = [];
  public readyState = CatalogWebSocket.CONNECTING;

  public constructor(public readonly url: string | URL) {}

  public addEventListener(type: string, listener: SocketListener): void {
    const listeners = this.listeners.get(type) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: SocketListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.readyState = CatalogWebSocket.CLOSED;
  }

  public open(): void {
    this.readyState = CatalogWebSocket.OPEN;
    this.emit("open", new globalThis.Event("open"));
  }

  public message(data: unknown): void {
    this.emit(
      "message",
      new globalThis.MessageEvent("message", { data: JSON.stringify(data) }),
    );
  }

  public fail(): void {
    this.emit("error", new globalThis.Event("error"));
  }

  private emit(type: string, event: SocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const catalogSocketFactory = (): {
  readonly constructor: T3WebSocketConstructor;
  readonly sockets: CatalogWebSocket[];
} => {
  const sockets: CatalogWebSocket[] = [];
  const Constructor = class extends CatalogWebSocket {
    public constructor(url: string | URL) {
      super(url);
      sockets.push(this);
    }
  };
  return {
    constructor: Constructor as unknown as T3WebSocketConstructor,
    sockets,
  };
};

const waitForSocket = async (
  sockets: readonly CatalogWebSocket[],
): Promise<CatalogWebSocket> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (sockets[0] !== undefined) return sockets[0];
    await Promise.resolve();
  }
  throw new Error("Expected catalog WebSocket construction");
};

const waitForRequest = async (
  socket: CatalogWebSocket,
): Promise<{ id: string; payload: unknown; tag: string; _tag: string }> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (socket.sent[0] !== undefined) return JSON.parse(socket.sent[0]);
    await Promise.resolve();
  }
  throw new Error("Expected catalog RPC request");
};

describe("resolveT3AwarenessPhase", () => {
  it.each<[string, Partial<T3ShellThread>, string]>([
    [
      "prioritizes approval",
      { hasPendingApprovals: true, hasPendingUserInput: true },
      "waiting_for_approval",
    ],
    [
      "prioritizes user input",
      { hasPendingUserInput: true },
      "waiting_for_input",
    ],
    ["maps a failed session", { session: { status: "error" } }, "failed"],
    [
      "maps a starting session",
      { session: { status: "starting" } },
      "starting",
    ],
    ["maps a running turn", { latestTurn: { state: "running" } }, "running"],
    [
      "maps a completed turn",
      { latestTurn: { state: "completed" } },
      "completed",
    ],
    [
      "counts an interrupted turn with completedAt as completed",
      {
        latestTurn: {
          state: "interrupted",
          completedAt: "2026-01-01T00:00:00Z",
        },
      },
      "completed",
    ],
    ["maps an idle session", { session: { status: "idle" } }, "completed"],
    [
      "leaves an interrupted unfinished turn unclassified",
      { latestTurn: { state: "interrupted" } },
      "none",
    ],
  ])("%s", (_name, value, expected) => {
    expect(resolveT3AwarenessPhase({ id: "thread-1", ...value })).toBe(
      expected,
    );
  });
});

describe("T3ControlPlaneClient", () => {
  it("reads only the non-secret provider catalog and defaults omitted availability to available", async () => {
    const { constructor: webSocket, sockets } = catalogSocketFactory();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse({
        expiresAt: "2026-09-07T00:05:00.000Z",
        ticket: "ticket-value-with+/symbols",
      }),
    );
    const client = new T3ControlPlaneClient({
      accessToken: "access-token",
      baseUrl: "https://t3.test/base-path",
      fetch,
      webSocket,
    });

    const reading = client.readProviderCatalog();
    const socket = await waitForSocket(sockets);
    expect(String(socket.url)).toBe(
      "wss://t3.test/ws?wsTicket=ticket-value-with%2B%2Fsymbols",
    );
    socket.open();
    const request = await waitForRequest(socket);
    expect(request).toMatchObject({
      _tag: "Request",
      payload: {},
      tag: "server.getConfig",
    });
    socket.message({
      _tag: "Exit",
      requestId: request.id,
      exit: {
        _tag: "Success",
        value: {
          auth: { sessionSecret: "must-not-leave-client" },
          providers: [
            {
              auth: { accessToken: "provider-secret" },
              displayName: "Workbench Alpha",
              driver: "sample-driver",
              enabled: true,
              installed: true,
              instanceId: "instance-alpha",
              models: [
                {
                  capabilities: null,
                  isCustom: false,
                  name: "Model Alpha",
                  slug: "model-alpha",
                },
                {
                  capabilities: null,
                  isCustom: true,
                  name: "Custom Model",
                  slug: "custom-model",
                },
              ],
              settings: { apiKey: "provider-secret" },
              status: "ready",
              version: "1.2.3",
            },
          ],
          settings: { secret: "must-not-leave-client" },
        },
      },
    });

    await expect(reading).resolves.toEqual([
      {
        availability: "available",
        displayName: "Workbench Alpha",
        driverKind: "sample-driver",
        enabled: true,
        installed: true,
        instanceId: "instance-alpha",
        models: [
          { isCustom: false, name: "Model Alpha", slug: "model-alpha" },
          { isCustom: true, name: "Custom Model", slug: "custom-model" },
        ],
        observedCliVersion: "1.2.3",
        state: "ready",
      },
    ]);
    expect(socket.readyState).toBe(CatalogWebSocket.CLOSED);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://t3.test/base-path/api/auth/websocket-ticket",
    );
    expect(
      new globalThis.Headers(fetch.mock.calls[0]?.[1]?.headers).get(
        "authorization",
      ),
    ).toBe("Bearer access-token");
  });

  it("closes the isolated catalog connection when the RPC fails", async () => {
    const { constructor: webSocket, sockets } = catalogSocketFactory();
    const client = new T3ControlPlaneClient({
      accessToken: "access-token",
      baseUrl: "http://t3.test",
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        jsonResponse({
          expiresAt: "2026-09-07T00:05:00.000Z",
          ticket: "ticket",
        }),
      ),
      webSocket,
    });

    const reading = client.readProviderCatalog();
    const socket = await waitForSocket(sockets);
    socket.open();
    const request = await waitForRequest(socket);
    socket.message({
      _tag: "Exit",
      requestId: request.id,
      exit: { _tag: "Failure", cause: { _tag: "Fail", error: "denied" } },
    });

    await expect(reading).rejects.toThrow(
      "T3 server.getConfig RPC did not return a successful provider catalog",
    );
    expect(socket.readyState).toBe(CatalogWebSocket.CLOSED);
  });

  it("requests a fresh ticket and connection for every catalog read", async () => {
    const { constructor: webSocket, sockets } = catalogSocketFactory();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ ticket: "ticket-one" }))
      .mockResolvedValueOnce(jsonResponse({ ticket: "ticket-two" }));
    const client = new T3ControlPlaneClient({
      accessToken: "access-token",
      baseUrl: "http://t3.test",
      fetch,
      webSocket,
    });

    for (const [index, ticket] of ["ticket-one", "ticket-two"].entries()) {
      const reading = client.readProviderCatalog();
      while (sockets[index] === undefined) await Promise.resolve();
      const socket = sockets[index]!;
      expect(String(socket.url)).toBe(`ws://t3.test/ws?wsTicket=${ticket}`);
      socket.open();
      const request = await waitForRequest(socket);
      socket.message({
        _tag: "Exit",
        requestId: request.id,
        exit: { _tag: "Success", value: { providers: [] } },
      });
      await expect(reading).resolves.toEqual([]);
      expect(socket.readyState).toBe(CatalogWebSocket.CLOSED);
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);
  });

  it("bounds a catalog WebSocket that never opens", async () => {
    vi.useFakeTimers();
    const { constructor: webSocket, sockets } = catalogSocketFactory();
    const client = new T3ControlPlaneClient({
      accessToken: "access-token",
      baseUrl: "http://t3.test",
      catalogTimeoutMilliseconds: 10,
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(jsonResponse({ ticket: "ticket" })),
      webSocket,
    });

    try {
      let failure: unknown;
      const reading = client.readProviderCatalog();
      void reading.catch((error: unknown) => {
        failure = error;
      });
      await waitForSocket(sockets);
      await vi.advanceTimersByTimeAsync(9);
      expect(failure).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain(
        "T3 server.getConfig RPC exceeded 10ms",
      );
      await expect(reading).rejects.toThrow(
        "T3 server.getConfig RPC exceeded 10ms",
      );
      expect(sockets).toHaveLength(1);
      expect(sockets[0]?.readyState).toBe(CatalogWebSocket.CLOSED);
    } finally {
      vi.useRealTimers();
    }
  });

  it("registers the workflow MCP endpoint and Bearer token through the authenticated provider-session route", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new globalThis.Response(undefined, { status: 204 }));
    const client = new T3ControlPlaneClient({
      baseUrl: "http://t3.test",
      accessToken: "access-token",
      fetch,
    });

    await client.registerWorkflowMcpProviderSession({
      authorizationHeader: "Bearer registration-token",
      endpoint: "http://127.0.0.1:4774/mcp",
      threadId: "thread-1",
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "http://t3.test/api/mcp/provider-session",
    );
    const request = fetch.mock.calls[0]?.[1];
    expect(request?.method).toBe("PUT");
    expect(new globalThis.Headers(request?.headers).get("authorization")).toBe(
      "Bearer access-token",
    );
    expect(JSON.parse(String(request?.body))).toEqual({
      authorizationHeader: "Bearer registration-token",
      endpoint: "http://127.0.0.1:4774/mcp",
      threadId: "thread-1",
    });
  });

  it("exchanges a pairing token with the RFC 8693 fields T3 requires", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "access-token",
          token_type: "Bearer",
          expires_in: 120,
          scope: "orchestration:read orchestration:operate",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ threads: [] }));
    const client = new T3ControlPlaneClient({
      baseUrl: "http://t3.test/",
      fetch,
    });

    await client.exchangePairingToken("pair-token", "heddle-test-client");
    await client.getShell();

    const exchange = fetch.mock.calls[0];
    expect(exchange?.[0]).toBe("http://t3.test/oauth/token");
    const body = exchange?.[1]?.body as InstanceType<
      typeof globalThis.URLSearchParams
    >;
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: "pair-token",
      subject_token_type:
        "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: "heddle-test-client",
    });
    expect(
      new globalThis.Headers(fetch.mock.calls[1]?.[1]?.headers).get(
        "authorization",
      ),
    ).toBe("Bearer access-token");
  });

  it("blocks a turn dispatch when its thread is absent", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ threads: [] }));
    const client = new T3ControlPlaneClient({
      baseUrl: "http://t3.test",
      accessToken: "access-token",
      fetch,
    });

    await expect(
      client.dispatch(
        {
          type: "thread.turn.start",
          commandId: "command-1",
          threadId: "missing-thread",
          runtimeMode: "auto-accept-edits",
        },
        {
          driver: "claudeAgent",
          cliVersion: "2.1.250",
          lifecycle: "independent",
        },
      ),
    ).rejects.toThrow(
      new T3PreconditionError(
        "Cannot dispatch 'thread.turn.start': thread 'missing-thread' does not exist",
      ),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("blocks a response when its request is absent", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          threads: [{ id: "thread-1", hasPendingApprovals: true }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ thread: { activities: [] } }));
    const client = new T3ControlPlaneClient({
      baseUrl: "http://t3.test",
      accessToken: "access-token",
      fetch,
    });

    await expect(
      client.respondToApproval("thread-1", "request-1", "accept", "command-1"),
    ).rejects.toThrow(
      "pending request 'request-1' does not exist on thread 'thread-1'",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("dispatches an approval response after its preconditions pass", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          threads: [{ id: "thread-1", hasPendingApprovals: true }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          thread: {
            activities: [
              {
                kind: "approval.requested",
                payload: { requestId: "request-1" },
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ sequence: 42 }));
    const client = new T3ControlPlaneClient({
      baseUrl: "http://t3.test",
      accessToken: "access-token",
      fetch,
    });

    await expect(
      client.respondToApproval("thread-1", "request-1", "accept", "command-1"),
    ).resolves.toEqual({ sequence: 42 });
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toMatchObject({
      type: "thread.approval.respond",
      commandId: "command-1",
      threadId: "thread-1",
      requestId: "request-1",
      decision: "accept",
    });
  });

  it("translates the domain reject action to T3 decline", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          threads: [{ id: "thread-1", hasPendingApprovals: true }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          thread: {
            activities: [
              {
                kind: "approval.requested",
                payload: { requestId: "request-1" },
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ sequence: 42 }));
    const client = new T3ControlPlaneClient({
      baseUrl: "http://t3.test",
      accessToken: "access-token",
      fetch,
    });

    await expect(
      client.respondToApproval("thread-1", "request-1", "reject", "command-1"),
    ).resolves.toEqual({ sequence: 42 });
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toMatchObject({
      type: "thread.approval.respond",
      commandId: "command-1",
      threadId: "thread-1",
      requestId: "request-1",
      decision: "decline",
    });
  });

  it("dispatches a user-input response after its preconditions pass", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          threads: [{ id: "thread-1", hasPendingUserInput: true }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          thread: {
            activities: [
              {
                kind: "user-input.requested",
                payload: { requestId: "request-1" },
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ sequence: 43 }));
    const client = new T3ControlPlaneClient({
      baseUrl: "http://t3.test",
      accessToken: "access-token",
      fetch,
    });

    await expect(
      client.respondToUserInput(
        "thread-1",
        "request-1",
        { question_1: ["Choice A"] },
        "command-1",
      ),
    ).resolves.toEqual({ sequence: 43 });
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toMatchObject({
      type: "thread.user-input.respond",
      commandId: "command-1",
      threadId: "thread-1",
      requestId: "request-1",
      answers: { question_1: ["Choice A"] },
    });
  });

  it("surfaces an opaque dispatch failure with status and body", async () => {
    const opaque = {
      _tag: "EnvironmentInternalError",
      code: "internal_error",
      traceId: "trace-1",
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse(opaque, 500));
    const client = new T3ControlPlaneClient({
      baseUrl: "http://t3.test",
      accessToken: "access-token",
      fetch,
    });

    await expect(
      client.dispatch({ type: "project.create", commandId: "command-1" }),
    ).rejects.toMatchObject<T3HttpError>({ status: 500, body: opaque });
  });
});
