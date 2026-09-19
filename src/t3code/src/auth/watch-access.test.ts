import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeT3Server } from "../../test/support/fake-server.js";
import { T3InterruptedError } from "../errors.js";
import { RpcClient } from "../rpc/client.js";
import { rpcMethods } from "../rpc/registry.js";
import { RpcConnection } from "../transport/rpc-connection.js";
import { SocketTransport } from "../transport/socket.js";
import { watchAccess } from "./watch-access.js";

describe("watchAccess", () => {
  let server: FakeT3Server;
  let connection: RpcConnection;
  let rpc: RpcClient<typeof rpcMethods>;

  beforeEach(async () => {
    server = await FakeT3Server.start();
    connection = new RpcConnection(new SocketTransport({ url: async () => server.wsUrl }));
    rpc = new RpcClient(connection, rpcMethods);
  });

  afterEach(async () => {
    await connection.close();
    await server.close();
  });

  it("unwraps access events and preserves decode errors from separate chunks", async () => {
    server.handle("subscribeAuthAccess", () => ({
      kind: "stream",
      chunks: [
        [{ version: 1, revision: 1, type: "clientRemoved", payload: { sessionId: "session-1" } }],
        [{ version: 1, revision: 2, type: "clientRemoved", payload: {} }],
      ],
    }));

    const items = [];
    for await (const item of watchAccess(rpc)) items.push(item);

    expect(items[0]).toMatchObject({ type: "clientRemoved", revision: 1 });
    expect(items[1]).toMatchObject({ kind: "decode-error" });
  });

  it("ends an active stream when its signal is aborted", async () => {
    server.handle("subscribeAuthAccess", () => ({ kind: "hang" }));
    const controller = new AbortController();
    const iterator = watchAccess(rpc, { signal: controller.signal })[Symbol.asyncIterator]();
    const next = iterator.next();
    await server.waitForConnections(1);

    controller.abort();

    await expect(next).rejects.toBeInstanceOf(T3InterruptedError);
  });
});
