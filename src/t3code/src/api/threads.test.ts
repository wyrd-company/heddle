import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeT3Server } from "../../test/support/fake-server.js";
import {
  approvalRequested,
  ids,
  makeShellSnapshot,
  makeShellThread,
  makeSnapshot,
  makeThread,
} from "../../test/support/thread-fixtures.js";
import { RpcClient } from "../rpc/client.js";
import { rpcMethods } from "../rpc/registry.js";
import { approvalRequestId, threadId } from "../schemas/common.js";
import type { OrchestrationThreadShell } from "../schemas/orchestration/shell.js";
import { HttpTransport } from "../transport/http.js";
import { RpcConnection } from "../transport/rpc-connection.js";
import { SocketTransport } from "../transport/socket.js";
import { CommandDispatcher } from "./dispatch.js";
import { ThreadsApi } from "./threads.js";

const invariant = (detail: string) => ({
  kind: "fail" as const,
  error: {
    _tag: "OrchestrationDispatchCommandError",
    message: `Orchestration command invariant failed (thread.delete): ${detail}`,
  },
});

describe("ThreadsApi", () => {
  let server: FakeT3Server;
  let connection: RpcConnection;
  let threads: ThreadsApi;
  let shellThreads: OrchestrationThreadShell[];
  let dispatched: Record<string, unknown>[];

  beforeEach(async () => {
    server = await FakeT3Server.start();
    shellThreads = [makeShellThread()];
    dispatched = [];
    connection = new RpcConnection(new SocketTransport({ url: async () => server.wsUrl }));
    const rpc = new RpcClient(connection, rpcMethods);
    const http = new HttpTransport({
      baseUrl: server.httpUrl,
      fetch: server.fetch,
      getAccessToken: async () => "token-1",
    });
    threads = new ThreadsApi(http, rpc, new CommandDispatcher(rpc, http));
    server.routes.route("GET /api/orchestration/shell", () => ({
      status: 200,
      body: makeShellSnapshot({ threads: shellThreads }),
    }));
    server.respond("orchestration.getArchivedShellSnapshot", makeShellSnapshot({}));
    server.handle("orchestration.dispatchCommand", (payload) => {
      const command = payload as Record<string, unknown>;
      dispatched.push(command);
      if (command["type"] === "thread.create") {
        shellThreads.push(
          makeShellThread({
            id: command["threadId"],
            projectId: command["projectId"],
            title: command["title"],
            runtimeMode: command["runtimeMode"],
          }),
        );
      }
      return { kind: "value", value: { sequence: dispatched.length } };
    });
  });
  afterEach(async () => {
    await connection.close();
    await server.close();
  });

  it("ensure returns the existing thread untouched and creates a missing one once", async () => {
    const existing = await threads.ensure({
      threadId: ids.threadId,
      projectId: ids.projectId,
      title: "Different title",
      modelSelection: { instanceId: "sample-provider" as never, model: "sample-model" },
    });
    expect(existing.title).toBe("Sample thread");
    expect(dispatched).toEqual([]);

    const input = {
      threadId: threadId("thread-2"),
      projectId: ids.projectId,
      title: "Second",
      modelSelection: { instanceId: "sample-provider" as never, model: "sample-model" },
      runtimeMode: "auto" as const,
    };
    const created = await threads.ensure(input);
    const again = await threads.ensure(input);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "thread.create",
      threadId: "thread-2",
      runtimeMode: "auto",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    expect(created.id).toBe("thread-2");
    expect(again.id).toBe("thread-2");
  });

  it("delete and archive resolve for a missing thread; archive tolerates already archived", async () => {
    server.handle("orchestration.dispatchCommand", () =>
      invariant("Thread 'missing' does not exist for command 'thread.delete'."),
    );
    await expect(threads.delete(threadId("missing"))).resolves.toBeUndefined();
    await expect(threads.archive(threadId("missing"))).resolves.toBeUndefined();
    server.handle("orchestration.dispatchCommand", () =>
      invariant(
        "Thread 'thread-1' is already archived and cannot handle command 'thread.archive'.",
      ),
    );
    await expect(threads.archive(ids.threadId)).resolves.toBeUndefined();
    await expect(threads.delete(ids.threadId)).rejects.toMatchObject({ code: "rpc_failed" });
  });

  it("fills bookkeeping fields on responses and mode changes", async () => {
    await threads.respondToApproval({
      threadId: ids.threadId,
      requestId: approvalRequestId("r1"),
      decision: "accept",
    });
    await threads.respondToUserInput({
      threadId: ids.threadId,
      requestId: approvalRequestId("r2"),
      answers: { q1: "yes" },
    });
    await threads.setRuntimeMode(ids.threadId, "approval-required");
    await threads.stopSession(ids.threadId);
    expect(dispatched.map((c) => c["type"])).toEqual([
      "thread.approval.respond",
      "thread.user-input.respond",
      "thread.runtime-mode.set",
      "thread.session.stop",
    ]);
    for (const command of dispatched) {
      expect(typeof command["commandId"]).toBe("string");
      expect(typeof command["createdAt"]).toBe("string");
    }
    expect(new Set(dispatched.map((c) => c["commandId"])).size).toBe(4);
  });

  it("reads detail and pending requests over HTTP and lists archived threads on request", async () => {
    const thread = makeThread({
      activities: [
        {
          id: "activity-1",
          tone: "approval",
          summary: "Sample",
          turnId: null,
          createdAt: "2020-01-01T00:00:00.000Z",
          ...approvalRequested("r1"),
        },
      ],
    });
    server.routes.route(`GET /api/orchestration/threads/${ids.threadId}`, (request) => ({
      status: 200,
      body: makeSnapshot(thread, request.query.get("turnLimit") === "3" ? 3 : 1),
    }));
    const detail = await threads.detail(ids.threadId, { turnLimit: 3 });
    expect(detail.snapshotSequence).toBe(3);
    const pending = await threads.pendingRequests(ids.threadId);
    expect(pending).toEqual([expect.objectContaining({ kind: "approval", requestId: "r1" })]);

    server.respond(
      "orchestration.getArchivedShellSnapshot",
      makeShellSnapshot({ threads: [makeShellThread({ id: "thread-archived" })] }),
    );
    expect((await threads.list()).map((t) => t.id)).toEqual(["thread-1"]);
    expect((await threads.list({ includeArchived: true })).map((t) => t.id)).toEqual([
      "thread-1",
      "thread-archived",
    ]);
    expect(await threads.get(threadId("thread-archived"))).toBeDefined();
    expect(threads.phase(makeShellThread({ hasPendingApprovals: true }))).toBe(
      "waiting_for_approval",
    );
  });
});
