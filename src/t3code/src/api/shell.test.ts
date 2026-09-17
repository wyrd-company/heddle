import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeT3Server } from "../../test/support/fake-server.js";
import {
  makeShellProject,
  makeShellSnapshot,
  makeShellThread,
} from "../../test/support/thread-fixtures.js";
import { RpcClient } from "../rpc/client.js";
import { rpcMethods } from "../rpc/registry.js";
import { HttpTransport } from "../transport/http.js";
import { RpcConnection } from "../transport/rpc-connection.js";
import { SocketTransport } from "../transport/socket.js";
import { ShellApi, type ShellWatchItem } from "./shell.js";

describe("ShellApi", () => {
  let server: FakeT3Server;
  let connection: RpcConnection;
  let shell: ShellApi;

  beforeEach(async () => {
    server = await FakeT3Server.start();
    connection = new RpcConnection(
      new SocketTransport({
        url: async () => server.wsUrl,
        backoff: { initialMs: 10, factor: 1, maxMs: 10 },
      }),
    );
    const http = new HttpTransport({
      baseUrl: server.httpUrl,
      fetch: server.fetch,
      getAccessToken: async () => "token-1",
    });
    shell = new ShellApi(http, new RpcClient(connection, rpcMethods));
  });
  afterEach(async () => {
    await connection.close();
    await server.close();
  });

  it("reads the snapshot over HTTP", async () => {
    server.routes.route("GET /api/orchestration/shell", () => ({
      status: 200,
      body: makeShellSnapshot({ projects: [makeShellProject()], snapshotSequence: 4 }),
    }));
    const snapshot = await shell.snapshot();
    expect(snapshot.snapshotSequence).toBe(4);
    expect(snapshot.projects[0]?.id).toBe("project-1");
  });

  it("watches, resumes after a drop with afterSequence, and skips replayed items", async () => {
    const payloads: Record<string, unknown>[] = [];
    const upsert = (sequence: number) => ({
      kind: "thread-upserted",
      sequence,
      thread: makeShellThread(),
    });
    server.handle("orchestration.subscribeShell", (payload, context) => {
      payloads.push(payload as Record<string, unknown>);
      if (payloads.length === 1) {
        context.connection.send({
          _tag: "Chunk",
          requestId: context.requestId,
          values: [{ kind: "snapshot", snapshot: makeShellSnapshot({ snapshotSequence: 5 }) }],
        });
        context.connection.send({
          _tag: "Chunk",
          requestId: context.requestId,
          values: [upsert(6), { kind: "something-new", sequence: 7 }],
        });
        return { kind: "hang" };
      }
      return {
        kind: "stream",
        chunks: [
          [upsert(6)],
          [{ kind: "synchronized" }],
          [{ kind: "project-removed", sequence: 8, projectId: "project-1" }],
        ],
      };
    });
    const items: ShellWatchItem[] = [];
    for await (const item of shell.watch()) {
      items.push(item);
      if (item.kind === "thread-upserted" && payloads.length === 1) server.connections[0]?.drop();
    }
    expect(payloads[1]).toMatchObject({ afterSequence: 6 });
    expect(items.map((i) => i.kind)).toEqual([
      "snapshot",
      "thread-upserted",
      "reconnected",
      "synchronized",
      "project-removed",
    ]);
  });
});
