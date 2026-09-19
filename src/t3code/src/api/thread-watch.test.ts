import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeT3Server } from "../../test/support/fake-server.js";
import {
  approvalRequested,
  approvalResolved,
  events,
  ids,
  makeSnapshot,
  makeThread,
} from "../../test/support/thread-fixtures.js";
import { RpcClient } from "../rpc/client.js";
import { rpcMethods } from "../rpc/registry.js";
import { RpcConnection } from "../transport/rpc-connection.js";
import { SocketTransport } from "../transport/socket.js";
import { isKnownVariant } from "./thread-projection.js";
import { watchThread, type ThreadWatchItem } from "./thread-watch.js";

const sequenceOf = (item: ThreadWatchItem): number | undefined =>
  item.kind === "event" && isKnownVariant(item.event) ? item.event.sequence : undefined;

const snapshotItem = (sequence: number, thread = makeThread()) => ({
  kind: "snapshot",
  snapshot: makeSnapshot(thread, sequence),
});
const eventItem = (event: Record<string, unknown>) => ({ kind: "event", event });

describe("watchThread", () => {
  let server: FakeT3Server;
  let connection: RpcConnection;
  let rpc: RpcClient<typeof rpcMethods>;

  beforeEach(async () => {
    server = await FakeT3Server.start();
    connection = new RpcConnection(
      new SocketTransport({
        url: async () => server.wsUrl,
        backoff: { initialMs: 10, factor: 1, maxMs: 10 },
      }),
    );
    rpc = new RpcClient(connection, rpcMethods);
  });
  afterEach(async () => {
    await connection.close();
    await server.close();
  });

  it("passes frames through and derives deltas, requests, and the settled turn", async () => {
    server.handle("orchestration.subscribeThread", () => ({
      kind: "stream",
      chunks: [
        [snapshotItem(10), { kind: "synchronized" }],
        [eventItem(events.sessionSet(11, { status: "running", activeTurnId: ids.turnId }))],
        [eventItem(events.messageSent(12, { messageId: "a1", text: "po" }))],
        [eventItem(events.activityAppended(13, approvalRequested("r1")))],
        [eventItem(events.activityAppended(14, approvalResolved("r1")))],
        [eventItem(events.messageSent(15, { messageId: "a1", text: "ng" }))],
        [eventItem(events.sessionSet(16, { status: "ready" }))],
      ],
    }));
    const items: ThreadWatchItem[] = [];
    for await (const item of watchThread(rpc, ids.threadId)) items.push(item);
    expect(items.map((i) => i.kind)).toEqual([
      "snapshot",
      "synchronized",
      "event",
      "event",
      "assistant-delta",
      "event",
      "approval-requested",
      "event",
      "request-resolved",
      "event",
      "assistant-delta",
      "event",
      "turn-settled",
    ]);
    const settled = items.at(-1);
    expect(settled?.kind === "turn-settled" && settled.outcome).toMatchObject({
      state: "completed",
      turnId: ids.turnId,
      assistantMessage: { id: "a1", text: "pong" },
    });
    const approval = items[6];
    expect(approval?.kind === "approval-requested" && approval.payload.requestKind).toBe("command");
  });

  it("announces requests that are already open in the snapshot", async () => {
    const thread = makeThread({
      activities: [
        {
          id: "activity-1",
          tone: "approval",
          summary: "Sample",
          turnId: null,
          createdAt: "2020-01-01T00:00:00.000Z",
          ...approvalRequested("r9"),
        },
      ],
    });
    server.handle("orchestration.subscribeThread", () => ({
      kind: "stream",
      chunks: [[snapshotItem(3, thread)]],
    }));
    const kinds: string[] = [];
    for await (const item of watchThread(rpc, ids.threadId)) kinds.push(item.kind);
    expect(kinds).toEqual(["snapshot", "approval-requested"]);
  });

  it("resumes after a dropped socket with afterSequence and without duplicate events", async () => {
    const payloads: Record<string, unknown>[] = [];
    server.handle("orchestration.subscribeThread", (payload, context) => {
      payloads.push(payload as Record<string, unknown>);
      if (payloads.length === 1) {
        const send = (value: unknown) =>
          context.connection.send({ _tag: "Chunk", requestId: context.requestId, values: [value] });
        send(snapshotItem(10));
        send(eventItem(events.sessionSet(11, { status: "running", activeTurnId: ids.turnId })));
        return { kind: "hang" };
      }
      return {
        kind: "stream",
        chunks: [
          [eventItem(events.sessionSet(11, { status: "running", activeTurnId: ids.turnId }))],
          [{ kind: "synchronized" }],
          [eventItem(events.sessionSet(12, { status: "ready" }))],
        ],
      };
    });
    const items: ThreadWatchItem[] = [];
    for await (const item of watchThread(rpc, ids.threadId)) {
      items.push(item);
      if (sequenceOf(item) === 11 && payloads.length === 1) {
        server.connections[0]?.drop();
      }
    }
    expect(payloads[0]).not.toHaveProperty("afterSequence");
    expect(payloads[1]).toMatchObject({ afterSequence: 11, threadId: ids.threadId });
    expect(items.map((i) => i.kind)).toEqual([
      "snapshot",
      "event",
      "reconnected",
      "synchronized",
      "event",
      "turn-settled",
    ]);
    const sequences = items.map(sequenceOf).filter((s) => s !== undefined);
    expect(sequences).toEqual([11, 12]);
    expect(items[2]).toEqual({ kind: "reconnected", afterSequence: 11 });
  });

  it("seeds from the snapshot loader when resuming and does not re-apply replayed events", async () => {
    const seeded = makeThread({
      messages: [
        {
          id: "a1",
          role: "assistant",
          text: "pong",
          turnId: ids.turnId,
          streaming: false,
          createdAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z",
        },
      ],
      latestTurn: {
        turnId: ids.turnId,
        state: "completed",
        requestedAt: "2020-01-01T00:00:00.000Z",
        startedAt: "2020-01-01T00:00:00.000Z",
        completedAt: "2020-01-01T00:00:01.000Z",
        assistantMessageId: "a1",
      },
    });
    server.handle("orchestration.subscribeThread", () => ({
      kind: "stream",
      chunks: [
        [eventItem(events.sessionSet(11, { status: "running", activeTurnId: ids.turnId }))],
        [eventItem(events.messageSent(12, { messageId: "a1", text: "pong" }))],
        [eventItem(events.sessionSet(13, { status: "ready" }))],
        [{ kind: "synchronized" }],
      ],
    }));
    const items: ThreadWatchItem[] = [];
    let loads = 0;
    const watch = watchThread(rpc, ids.threadId, {
      afterSequence: 10,
      snapshotLoader: async () => {
        loads += 1;
        return makeSnapshot(seeded, 13);
      },
    });
    for await (const item of watch) items.push(item);
    expect(loads).toBe(1);
    expect(items.map((i) => i.kind)).toEqual([
      "snapshot",
      "event",
      "turn-settled",
      "event",
      "assistant-delta",
      "event",
      "synchronized",
    ]);
    const settled = items[2];
    expect(settled?.kind === "turn-settled" && settled.outcome.assistantMessage?.text).toBe("pong");
  });

  it("returns silently on abort and throws on a fatal connection error", async () => {
    server.handle("orchestration.subscribeThread", (_payload, context) => {
      context.connection.send({
        _tag: "Chunk",
        requestId: context.requestId,
        values: [snapshotItem(1)],
      });
      return { kind: "hang" };
    });
    const controller = new AbortController();
    const kinds: string[] = [];
    for await (const item of watchThread(rpc, ids.threadId, { signal: controller.signal })) {
      kinds.push(item.kind);
      controller.abort();
    }
    expect(kinds).toEqual(["snapshot"]);

    await connection.close();
    const iterator = watchThread(rpc, ids.threadId)[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ code: "connection" });
  });
});
