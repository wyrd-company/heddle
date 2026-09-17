import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeT3Server } from "../../test/support/fake-server.js";
import {
  at,
  events,
  ids,
  makeMessage,
  makeSession,
  makeShellSnapshot,
  makeShellThread,
  makeSnapshot,
  makeThread,
} from "../../test/support/thread-fixtures.js";
import { RpcClient } from "../rpc/client.js";
import { rpcMethods } from "../rpc/registry.js";
import { turnId } from "../schemas/common.js";
import type { OrchestrationThreadDetailSnapshot } from "../schemas/orchestration/read-model.js";
import { HttpTransport } from "../transport/http.js";
import { RpcConnection } from "../transport/rpc-connection.js";
import { SocketTransport } from "../transport/socket.js";
import { CommandDispatcher } from "./dispatch.js";
import { ThreadsApi } from "./threads.js";
import type { ThreadWatchItem } from "./thread-watch.js";
import { inspectTurn } from "./turns.js";

const eventItem = (event: Record<string, unknown>) => ({ kind: "event", event });

describe("ThreadsApi.startTurn", () => {
  let server: FakeT3Server;
  let connection: RpcConnection;
  let threads: ThreadsApi;
  let dispatched: Record<string, unknown>[];
  let subscriptions: Record<string, unknown>[];

  beforeEach(async () => {
    server = await FakeT3Server.start();
    dispatched = [];
    subscriptions = [];
    connection = new RpcConnection(new SocketTransport({ url: async () => server.wsUrl }));
    const rpc = new RpcClient(connection, rpcMethods);
    const http = new HttpTransport({
      baseUrl: server.httpUrl,
      fetch: server.fetch,
      getAccessToken: async () => "token-1",
    });
    const clock = { now: () => new Date("2020-01-01T00:00:10.000Z") };
    threads = new ThreadsApi(http, rpc, new CommandDispatcher(rpc, http, { clock }));
    server.handle("orchestration.dispatchCommand", (payload) => {
      dispatched.push(payload as Record<string, unknown>);
      return { kind: "value", value: { sequence: 10 } };
    });
    server.routes.route("GET /api/orchestration/shell", () => ({
      status: 200,
      body: makeShellSnapshot({ threads: [makeShellThread({ runtimeMode: "auto" })] }),
    }));
    server.routes.route(`GET /api/orchestration/threads/${ids.threadId}`, () => ({
      status: 200,
      body: makeSnapshot(makeThread(), 10),
    }));
  });
  afterEach(async () => {
    await connection.close();
    await server.close();
  });

  const scriptTurn = (extra: Record<string, unknown>[] = []) =>
    server.handle("orchestration.subscribeThread", (payload) => {
      subscriptions.push(payload as Record<string, unknown>);
      return {
        kind: "stream",
        chunks: [
          [eventItem(events.sessionSet(11, { status: "running", activeTurnId: ids.turnId }))],
          [eventItem(events.messageSent(12, { messageId: "a1", text: "po" }))],
          [eventItem(events.messageSent(13, { messageId: "a1", text: "ng" }))],
          [eventItem(events.messageSent(14, { messageId: "a1", text: "pong", streaming: false }))],
          [eventItem(events.sessionSet(15, { status: "ready" }))],
          ...extra.map((event) => [eventItem(event)]),
        ],
      };
    });

  it("dispatches the command with generated ids and resolves completion from the events", async () => {
    scriptTurn();
    const handle = await threads.startTurn({ threadId: ids.threadId, text: "Say pong." });
    expect(handle.sequence).toBe(10);
    expect(dispatched[0]).toMatchObject({
      type: "thread.turn.start",
      commandId: handle.commandId,
      threadId: ids.threadId,
      runtimeMode: "auto",
      interactionMode: "default",
      message: { messageId: handle.messageId, role: "user", text: "Say pong.", attachments: [] },
    });
    const items: ThreadWatchItem[] = [];
    const collect = (async () => {
      for await (const item of handle.events()) items.push(item);
    })();
    const outcome = await handle.completion;
    await collect;
    expect(outcome).toMatchObject({
      state: "completed",
      turnId: ids.turnId,
      assistantMessage: { id: "a1", text: "pong" },
    });
    expect(outcome.error).toBeUndefined();
    expect(subscriptions[0]).toMatchObject({ threadId: ids.threadId, afterSequence: 10 });
    expect(items[0]?.kind).toBe("snapshot");
    expect(
      items
        .filter((i) => i.kind === "assistant-delta")
        .map((i) => i.kind === "assistant-delta" && i.text),
    ).toEqual(["po", "ng"]);
    expect(items.at(-1)?.kind).toBe("turn-settled");
  });

  it("resolves completion without events() being consumed", async () => {
    scriptTurn();
    const handle = await threads.startTurn({
      threadId: ids.threadId,
      text: "Say pong.",
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    await expect(handle.completion).resolves.toMatchObject({ state: "completed" });
    expect(server.routes.requests.map((r) => r.path)).not.toContain("/api/orchestration/shell");
  });

  it("resolves an error outcome when the session fails before the turn starts", async () => {
    server.handle("orchestration.subscribeThread", () => ({
      kind: "stream",
      chunks: [[eventItem(events.sessionSet(11, { status: "error", lastError: "provider down" }))]],
    }));
    const handle = await threads.startTurn({ threadId: ids.threadId, text: "Say pong." });
    await expect(handle.completion).resolves.toMatchObject({
      state: "error",
      turnId: null,
      error: "provider down",
    });
  });

  it("interrupt() dispatches thread.turn.interrupt with the known turn id", async () => {
    server.handle("orchestration.subscribeThread", (_payload, context) => {
      context.connection.send({
        _tag: "Chunk",
        requestId: context.requestId,
        values: [eventItem(events.sessionSet(11, { status: "running", activeTurnId: ids.turnId }))],
      });
      return { kind: "hang" };
    });
    const handle = await threads.startTurn({ threadId: ids.threadId, text: "Say pong." });
    const iterator = handle.events()[Symbol.asyncIterator]();
    await iterator.next(); // snapshot
    await iterator.next(); // session-set event
    await handle.interrupt();
    expect(dispatched[1]).toMatchObject({
      type: "thread.turn.interrupt",
      threadId: ids.threadId,
      turnId: ids.turnId,
    });
    await iterator.return?.();
  });

  it("rejects completion with T3InterruptedError when the caller aborts", async () => {
    server.handle("orchestration.subscribeThread", () => ({ kind: "hang" }));
    const controller = new AbortController();
    const handle = await threads.startTurn({
      threadId: ids.threadId,
      text: "Say pong.",
      signal: controller.signal,
    });
    const completion = handle.completion;
    controller.abort();
    await expect(completion).rejects.toMatchObject({ code: "interrupted" });
  });

  it("events() buffers nothing until iterated and drops a consumer that returns", async () => {
    server.handle("orchestration.subscribeThread", (_payload, context) => {
      context.connection.send({
        _tag: "Chunk",
        requestId: context.requestId,
        values: [eventItem(events.sessionSet(11, { status: "running", activeTurnId: ids.turnId }))],
      });
      return { kind: "hang" };
    });
    const controller = new AbortController();
    const handle = await threads.startTurn({
      threadId: ids.threadId,
      text: "Say pong.",
      signal: controller.signal,
    });
    const idle = handle.events(); // never iterated
    const completion = handle.completion;
    const iterator = handle.events()[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    expect(inspectTurn(handle)).toEqual({ subscribers: 1, buffered: 0 });
    await iterator.return?.();
    expect(inspectTurn(handle)).toEqual({ subscribers: 0, buffered: 0 });
    void idle;
    controller.abort();
    await expect(completion).rejects.toMatchObject({ code: "interrupted" });
  });

  it("two turns started back to back both follow the one provider turn they were folded into", async () => {
    let sequence = 20;
    server.handle("orchestration.dispatchCommand", (payload) => {
      dispatched.push(payload as Record<string, unknown>);
      sequence += 4;
      return { kind: "value", value: { sequence } };
    });
    const script = (from: number) =>
      [
        eventItem(events.sessionSet(23, { status: "starting" })),
        eventItem(events.sessionSet(28, { status: "starting" })),
        eventItem(events.sessionSet(31, { status: "running", activeTurnId: ids.turnId })),
        eventItem(events.messageSent(32, { messageId: "a1", text: "One", streaming: false })),
        eventItem(events.messageSent(36, { messageId: "a2", text: "marmalade", streaming: false })),
        eventItem(events.sessionSet(39, { status: "ready" })),
      ]
        .filter((item) => (item.event["sequence"] as number) > from)
        .map((item) => [item]);
    server.handle("orchestration.subscribeThread", (payload) => ({
      kind: "stream",
      chunks: script((payload as { afterSequence: number }).afterSequence),
    }));
    let detail: OrchestrationThreadDetailSnapshot = makeSnapshot(makeThread(), 20);
    server.routes.route(`GET /api/orchestration/threads/${ids.threadId}`, () => ({
      status: 200,
      body: detail,
    }));

    const first = await threads.startTurn({ threadId: ids.threadId, text: "Count to five." });
    expect(first.sequence).toBe(24);
    const second = await threads.startTurn({ threadId: ids.threadId, text: "Say marmalade." });
    expect(second.sequence).toBe(28);
    detail = makeSnapshot(
      makeThread({
        messages: [
          makeMessage({ id: first.messageId, role: "user", turnId: null, createdAt: at }),
          makeMessage({ id: second.messageId, role: "user", turnId: null, createdAt: at }),
        ],
        session: makeSession({ status: "starting" }),
      }),
      28,
    );
    const [one, two] = await Promise.all([first.completion, second.completion]);
    expect(one).toMatchObject({ state: "completed", turnId: ids.turnId });
    expect(two).toMatchObject({
      state: "completed",
      turnId: ids.turnId,
      assistantMessage: { id: "a2", text: "marmalade" },
    });
  });

  it("a turn started during a running one resolves when that turn settles, or follows a turn that supersedes it", async () => {
    const turnB = turnId("turn-2");
    server.routes.route(`GET /api/orchestration/threads/${ids.threadId}`, () => ({
      status: 200,
      body: makeSnapshot(
        makeThread({
          session: makeSession({ status: "running", activeTurnId: ids.turnId }),
          latestTurn: {
            turnId: ids.turnId,
            state: "running",
            requestedAt: at,
            startedAt: at,
            completedAt: null,
            assistantMessageId: null,
          },
        }),
        10,
      ),
    }));
    server.handle("orchestration.subscribeThread", () => ({
      kind: "stream",
      chunks: [
        [eventItem(events.sessionSet(11, { status: "running", activeTurnId: turnB }))],
        [
          eventItem(
            events.messageSent(12, {
              messageId: "b1",
              text: "beta",
              streaming: false,
              turnId: turnB,
            }),
          ),
        ],
        [eventItem(events.sessionSet(13, { status: "ready" }))],
      ],
    }));
    const handle = await threads.startTurn({ threadId: ids.threadId, text: "Say beta." });
    await expect(handle.completion).resolves.toMatchObject({
      state: "completed",
      turnId: turnB,
      assistantMessage: { id: "b1", text: "beta" },
    });
  });
});
