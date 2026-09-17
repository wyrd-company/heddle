import { WebSocket as WsWebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeT3Server } from "../../test/support/fake-server.js";
import { T3AuthError, T3ConnectionError } from "../errors.js";
import type { WebSocketConstructor } from "../internal/websocket.js";
import { SocketTransport, type SocketState } from "./socket.js";

const fastBackoff = { initialMs: 10, factor: 1, maxMs: 10 };
const until = async (check: () => boolean, ms = 3_000): Promise<void> => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("Timed out.");
    await new Promise((r) => setTimeout(r, 5));
  }
};

const implementations: Array<[string, WebSocketConstructor | undefined]> = [
  ["global WebSocket", undefined],
  ["ws package", WsWebSocket as unknown as WebSocketConstructor],
];

describe.each(implementations)("SocketTransport (%s)", (_name, webSocket) => {
  let server: FakeT3Server;
  let transport: SocketTransport | undefined;
  const states: Array<[SocketState, string | undefined]> = [];

  const make = (
    options: Partial<ConstructorParameters<typeof SocketTransport>[0]> = {},
  ): SocketTransport => {
    transport = new SocketTransport({
      url: async () => server.wsUrl,
      backoff: fastBackoff,
      ...(webSocket ? { webSocket } : {}),
      ...options,
    });
    transport.onStateChange((state, error) => states.push([state, error?.reason]));
    return transport;
  };

  beforeEach(async () => {
    server = await FakeT3Server.start();
    states.length = 0;
  });
  afterEach(async () => {
    await transport?.close();
    await server.close();
  });

  it("connects idempotently and reports state", async () => {
    const t = make();
    await Promise.all([t.connect(), t.connect()]);
    expect(t.state).toBe("open");
    expect(server.connections).toHaveLength(1);
    expect(states).toEqual([
      ["connecting", undefined],
      ["open", undefined],
    ]);
    await t.close();
    expect(t.state).toBe("closed");
    await expect(t.connect()).rejects.toBeInstanceOf(T3ConnectionError);
  });

  it("sends bearer headers and a ticket query from the url/headers functions", async () => {
    server.token = "secret";
    const t = make({ headers: async () => ({ authorization: "Bearer secret" }) });
    await t.connect();
    expect(server.upgrades[0]?.headers["authorization"]).toBe("Bearer secret");
    await t.close();
    const ticket = server.issueTicket();
    const t2 = make({
      url: async () => new URL(`${server.wsUrl}?wsTicket=${ticket}&clientSurface=cli`),
    });
    await t2.connect();
    expect(server.upgrades[1]?.query).toEqual({ wsTicket: ticket, clientSurface: "cli" });
  });

  it("pings on the interval and consumes Pongs", async () => {
    const t = make({ pingIntervalMs: 20 });
    const frames: unknown[] = [];
    t.onMessage((envelopes) => frames.push(...envelopes));
    await t.connect();
    await until(() => server.pings >= 3);
    expect(frames).toEqual([]);
    expect(t.state).toBe("open");
  });

  it("reconnects with a ping_timeout when pongs stop", async () => {
    const t = make({ pingIntervalMs: 15, missedPongLimit: 2 });
    await t.connect();
    server.lastConnection.answerPings = false;
    await server.waitForConnections(2);
    await until(() => t.state === "open" && server.connections.length === 2);
    expect(states.map(([s, r]) => `${s}:${r ?? ""}`)).toContain("connecting:ping_timeout");
  });

  it("reconnects after a dropped connection and refreshes the url", async () => {
    let calls = 0;
    const t = make({
      url: async () => {
        calls += 1;
        return new URL(`${server.wsUrl}?attempt=${calls}`);
      },
    });
    await t.connect();
    server.lastConnection.drop();
    await server.waitForConnections(2);
    await until(() => t.state === "open");
    expect(server.upgrades.map((u) => u.query["attempt"])).toEqual(["1", "2"]);
    expect(states).toContainEqual(["connecting", "closed"]);
    expect(states.at(-1)).toEqual(["open", undefined]);
    t.send('{"_tag":"Ping"}');
  });

  it("delivers decoded envelopes and drops Pong-only frames", async () => {
    const t = make();
    const frames: unknown[][] = [];
    t.onMessage((envelopes) => frames.push([...envelopes]));
    await t.connect();
    server.lastConnection.sendBatch([
      { _tag: "Pong" },
      { _tag: "Chunk", requestId: "1", values: [1] },
    ]);
    server.lastConnection.send({ _tag: "Pong" });
    await until(() => frames.length >= 1);
    expect(frames).toEqual([[{ _tag: "Chunk", requestId: "1", values: [1] }]]);
  });

  it("treats a T3AuthError from url() as fatal", async () => {
    const t = make({
      url: async () => {
        throw T3AuthError.insufficientScope("orchestration:read", "ticket");
      },
    });
    await expect(t.connect()).rejects.toMatchObject({ code: "connection", reason: "open_failed" });
    expect(t.state).toBe("closed");
  });

  it("send throws when not open", () => {
    const t = make();
    expect(() => t.send("x")).toThrowError(T3ConnectionError);
  });

  it("leaves no abort listeners on a signal shared by many connect() waiters", async () => {
    const t = make();
    const { signal } = new AbortController();
    const added = vi.spyOn(signal, "addEventListener");
    const removed = vi.spyOn(signal, "removeEventListener");
    await Promise.all(Array.from({ length: 50 }, () => t.connect(signal)));
    expect(added).toHaveBeenCalledTimes(50);
    expect(removed).toHaveBeenCalledTimes(50);
    await t.close();
    const t2 = make();
    const rejected = Promise.all(Array.from({ length: 50 }, () => t2.connect(signal)));
    await t2.close();
    await expect(rejected).rejects.toBeInstanceOf(T3ConnectionError);
    expect(removed.mock.calls.length).toBe(added.mock.calls.length);
  });

  it("reconnect() drops the socket, resolves the url again, and opens a new connection", async () => {
    let calls = 0;
    const t = make({
      url: async () => {
        calls += 1;
        return new URL(`${server.wsUrl}?attempt=${calls}`);
      },
    });
    await t.connect();
    t.reconnect();
    expect(t.state).toBe("connecting");
    expect(states.at(-1)).toEqual(["connecting", "closed"]);
    await t.connect();
    expect(server.upgrades.map((u) => u.query["attempt"])).toEqual(["1", "2"]);
    expect(t.state).toBe("open");
    t.send('{"_tag":"Ping"}');
    await until(() => server.lastConnection.pings >= 1);
    expect(server.connections[0]?.pings).toBe(0);
  });
});

describe("SocketTransport upgrade rejection (ws package exposes the status)", () => {
  it("stops reconnecting on a 401 upgrade", async () => {
    const server = await FakeT3Server.start({ token: "secret" });
    const states: Array<[SocketState, string | undefined]> = [];
    const t = new SocketTransport({
      url: async () => server.wsUrl,
      headers: async () => ({ authorization: "Bearer wrong" }),
      webSocket: WsWebSocket as unknown as WebSocketConstructor,
      backoff: fastBackoff,
    });
    t.onStateChange((state, error) => states.push([state, error?.reason]));
    await expect(t.connect()).rejects.toMatchObject({ reason: "open_failed" });
    await new Promise((r) => setTimeout(r, 50));
    expect(server.upgrades).toHaveLength(1);
    expect(states.at(-1)).toEqual(["closed", "open_failed"]);
    await t.close();
    await server.close();
  });
});
