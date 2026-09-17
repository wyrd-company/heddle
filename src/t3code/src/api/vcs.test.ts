import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeT3Server } from "../../test/support/fake-server.js";
import { RpcClient } from "../rpc/client.js";
import { rpcMethods } from "../rpc/registry.js";
import { RpcConnection } from "../transport/rpc-connection.js";
import { SocketTransport } from "../transport/socket.js";
import { VcsApi } from "./vcs.js";

const localStatus = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "sample-ref",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};

describe("VcsApi", () => {
  let server: FakeT3Server;
  let connection: RpcConnection;
  let api: VcsApi;

  beforeEach(async () => {
    server = await FakeT3Server.start();
    connection = new RpcConnection(new SocketTransport({ url: async () => server.wsUrl }));
    api = new VcsApi(new RpcClient(connection, rpcMethods));
  });

  afterEach(async () => {
    await connection.close();
    await server.close();
  });

  it("creates a ref through the registered RPC method", async () => {
    server.respond("vcs.createRef", { refName: "sample-ref" });

    await expect(api.createRef({ cwd: "/tmp/sample", refName: "sample-ref" })).resolves.toEqual({
      refName: "sample-ref",
    });
  });

  it("unwraps status events and preserves decode errors from separate chunks", async () => {
    server.handle("subscribeVcsStatus", () => ({
      kind: "stream",
      chunks: [
        [{ _tag: "snapshot", local: localStatus, remote: null }],
        [{ _tag: "localUpdated", local: { isRepo: true } }],
      ],
    }));

    const items = [];
    for await (const item of api.watchStatus({ cwd: "/tmp/sample" })) items.push(item);

    expect(items[0]).toMatchObject({ _tag: "snapshot", local: { refName: "sample-ref" } });
    expect(items[1]).toMatchObject({ kind: "decode-error" });
  });
});
