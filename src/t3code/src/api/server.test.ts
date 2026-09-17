import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeT3Server } from "../../test/support/fake-server.js";
import { RpcClient } from "../rpc/client.js";
import { rpcMethods } from "../rpc/registry.js";
import { HttpTransport } from "../transport/http.js";
import { RpcConnection } from "../transport/rpc-connection.js";
import { SocketTransport } from "../transport/socket.js";
import { ServerApi } from "./server.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/${name}.json`, import.meta.url), "utf8"));

describe("ServerApi", () => {
  let server: FakeT3Server;
  let connection: RpcConnection;
  let api: ServerApi;

  beforeEach(async () => {
    server = await FakeT3Server.start();
    connection = new RpcConnection(new SocketTransport({ url: async () => server.wsUrl }));
    api = new ServerApi(
      new RpcClient(connection, rpcMethods),
      new HttpTransport({ baseUrl: server.httpUrl, getAccessToken: async () => undefined }),
    );
  });

  afterEach(async () => {
    await connection.close();
    await server.close();
  });

  it("gets the server config and unauthenticated environment descriptor", async () => {
    const config = fixture("server-config") as Record<string, unknown>;
    const environment = fixture("environment");
    server.respond("server.getConfig", config);
    server.routes.route("GET /.well-known/t3/environment", () => ({
      status: 200,
      body: environment,
    }));

    await expect(api.getConfig()).resolves.toMatchObject({ cwd: "/tmp/example" });
    await expect(api.environment()).resolves.toMatchObject({ label: "Example" });
    expect(server.routes.requests[0]?.headers["authorization"]).toBeUndefined();
  });

  it("finds a provider model by slug or alias", async () => {
    const config = fixture("server-config") as {
      providers: Array<{ models: Array<{ aliases?: string[] }> }>;
    };
    config.providers[0]?.models[0]?.aliases?.push("sample-alias");
    if (config.providers[0]?.models[0]?.aliases === undefined && config.providers[0]?.models[0]) {
      config.providers[0].models[0].aliases = ["sample-alias"];
    }
    server.respond("server.getConfig", config);

    await expect(api.findModel("codex", "gpt-6-astra")).resolves.toMatchObject({
      model: { slug: "gpt-6-astra" },
    });
    await expect(api.findModel("codex", "sample-alias")).resolves.toMatchObject({
      model: { slug: "gpt-6-astra" },
    });
  });

  it("unwraps lifecycle events and preserves decode errors from separate chunks", async () => {
    const environment = fixture("environment");
    server.handle("subscribeServerLifecycle", () => ({
      kind: "stream",
      chunks: [
        [
          {
            version: 1,
            sequence: 1,
            type: "ready",
            payload: { at: "2026-01-01T00:00:00.000Z", environment },
          },
        ],
        [{ version: 1, sequence: 2, type: "ready", payload: {} }],
      ],
    }));

    const items = [];
    for await (const item of api.watchLifecycle()) items.push(item);

    expect(items[0]).toMatchObject({ type: "ready", sequence: 1 });
    expect(items[1]).toMatchObject({ kind: "decode-error" });
  });
});
