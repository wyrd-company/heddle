import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeT3Server } from "../../test/support/fake-server.js";
import { RpcClient } from "../rpc/client.js";
import { rpcMethods } from "../rpc/registry.js";
import { RpcConnection } from "../transport/rpc-connection.js";
import { SocketTransport } from "../transport/socket.js";
import { TerminalApi } from "./terminal.js";

const snapshot = {
  threadId: "record-1",
  terminalId: "terminal-1",
  cwd: "/tmp/sample",
  worktreePath: null,
  status: "running",
  pid: 1234,
  history: "",
  exitCode: null,
  exitSignal: null,
  label: "Sample terminal",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("TerminalApi", () => {
  let server: FakeT3Server;
  let connection: RpcConnection;
  let api: TerminalApi;

  beforeEach(async () => {
    server = await FakeT3Server.start();
    connection = new RpcConnection(new SocketTransport({ url: async () => server.wsUrl }));
    api = new TerminalApi(new RpcClient(connection, rpcMethods));
  });

  afterEach(async () => {
    await connection.close();
    await server.close();
  });

  it("opens a terminal through the registered RPC method", async () => {
    server.respond("terminal.open", snapshot);

    await expect(
      api.open({ threadId: "record-1", terminalId: "terminal-1", cwd: "/tmp/sample" }),
    ).resolves.toMatchObject({ terminalId: "terminal-1", status: "running" });
  });

  it("unwraps terminal events and preserves decode errors from separate chunks", async () => {
    server.handle("subscribeTerminalEvents", () => ({
      kind: "stream",
      chunks: [
        [{ type: "started", threadId: "record-1", terminalId: "terminal-1", snapshot }],
        [{ type: "output", threadId: "record-1", terminalId: "terminal-1" }],
      ],
    }));

    const items = [];
    for await (const item of api.watchEvents()) items.push(item);

    expect(items[0]).toMatchObject({ type: "started", snapshot: { status: "running" } });
    expect(items[1]).toMatchObject({ kind: "decode-error" });
  });
});
