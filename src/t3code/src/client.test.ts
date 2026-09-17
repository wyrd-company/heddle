import { WebSocket as WsWebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeT3Server } from "../test/support/fake-server.js";
import { makeShellSnapshot } from "../test/support/thread-fixtures.js";
import { memoryCredentialStore } from "./auth/credential-store.js";
import { T3Client } from "./client.js";
import type { WebSocketConstructor } from "./internal/websocket.js";

const webSocket = WsWebSocket as unknown as WebSocketConstructor;

const authDescriptor = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "session",
};

describe("T3Client", () => {
  let server: FakeT3Server;
  let client: T3Client | undefined;
  /** Scopes the fake session route reports per bearer token. */
  const scopesByToken: Record<string, string[]> = {};

  beforeEach(async () => {
    server = await FakeT3Server.start({ token: "token-1" });
    scopesByToken["token-1"] = ["orchestration:read", "orchestration:operate"];
    server.routes.route("POST /api/auth/websocket-ticket", (request) => {
      if (request.headers["authorization"] !== `Bearer ${server.token}`) return { status: 401 };
      return {
        status: 200,
        body: { ticket: server.issueTicket(), expiresAt: "2020-01-01T00:05:00.000Z" },
      };
    });
    server.routes.route("GET /api/auth/session", (request) => {
      const token = request.headers["authorization"]?.replace(/^Bearer /u, "");
      const scopes = token === undefined ? undefined : scopesByToken[token];
      if (scopes === undefined)
        return { status: 200, body: { authenticated: false, auth: authDescriptor } };
      return { status: 200, body: { authenticated: true, auth: authDescriptor, scopes } };
    });
    server.routes.route("GET /api/orchestration/shell", () => ({
      status: 200,
      body: makeShellSnapshot({}),
    }));
    server.respond("server.probe", {});
  });
  afterEach(async () => {
    await client?.close();
    await server.close();
  });

  it("connects in ticket mode with the labelled upgrade URL and exposes every facade", async () => {
    client = T3Client.create({
      baseUrl: server.httpUrl,
      accessToken: "token-1",
      clientLabel: "sample-workflow",
      clientAppVersion: "1.2.3",
      fetch: server.fetch,
      webSocket,
    });
    await client.server.probe();
    const upgrade = server.upgrades[0];
    expect(upgrade?.accepted).toBe(true);
    expect(upgrade?.url.pathname).toBe("/ws");
    expect(server.tickets.has(upgrade?.query["wsTicket"] ?? "")).toBe(true);
    expect(upgrade?.query).toMatchObject({ clientSurface: "cli", clientAppVersion: "1.2.3" });
    expect(upgrade?.headers["authorization"]).toBeUndefined();
    expect(server.routes.requests.map((r) => r.path)).toContain("/api/auth/websocket-ticket");
    expect(server.routes.requests[0]?.headers["user-agent"]).toBe(
      "t3code-client/1.2.3 (sample-workflow)",
    );

    expect(await client.projects.list()).toEqual([]);
    expect(await client.shell.snapshot()).toMatchObject({ snapshotSequence: 1 });
    expect(client.threads).toBeDefined();
    expect(client.mcp).toBeDefined();
    expect(client.vcs).toBeDefined();
    expect(client.terminal).toBeDefined();
    expect(client.auth).toBeDefined();
    await expect(client.rpc.call("server.probe", {})).resolves.toBeDefined();
  });

  it("connects in bearer-header mode without a ticket", async () => {
    client = T3Client.create({
      baseUrl: server.httpUrl,
      credentials: memoryCredentialStore({ accessToken: "token-1" }),
      socketAuth: "bearer-header",
      fetch: server.fetch,
      webSocket,
    });
    await client.connect();
    const upgrade = server.upgrades[0];
    expect(upgrade?.accepted).toBe(true);
    expect(upgrade?.headers["authorization"]).toBe("Bearer token-1");
    expect(upgrade?.query["wsTicket"]).toBeUndefined();
    expect(server.routes.requests.map((r) => r.path)).not.toContain("/api/auth/websocket-ticket");
    expect(server.routes.requests.map((r) => r.path)).toContain("/api/auth/session");
  });

  it("fails fast in bearer-header mode when the token no longer authenticates", async () => {
    // The global WebSocket cannot see the 401 on the upgrade (it looks like a 1006
    // drop), so the token is validated over HTTP before every attempt instead.
    client = T3Client.create({
      baseUrl: server.httpUrl,
      credentials: memoryCredentialStore({ accessToken: "token-expired" }),
      socketAuth: "bearer-header",
      fetch: server.fetch,
    });
    const error = await client.connect().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "connection", reason: "open_failed" });
    expect((error as { cause?: unknown }).cause).toMatchObject({
      code: "auth_invalid",
      reason: "invalid_credential",
    });
    expect(server.upgrades).toHaveLength(0);
    await expect(client.connect()).rejects.toMatchObject({ reason: "closed" });

    const missing = T3Client.create({
      baseUrl: server.httpUrl,
      socketAuth: "bearer-header",
      fetch: server.fetch,
    });
    await expect(missing.connect()).rejects.toMatchObject({ reason: "open_failed" });
    await missing.close();
  });

  it("re-authenticates the socket and uses the new scopes after the token changes", async () => {
    scopesByToken["token-2"] = ["orchestration:read"];
    client = T3Client.create({
      baseUrl: server.httpUrl,
      credentials: memoryCredentialStore({
        accessToken: "token-1",
        scopes: ["orchestration:read", "orchestration:operate"],
      }),
      fetch: server.fetch,
      webSocket,
    });
    await client.connect();
    server.respond("orchestration.dispatchCommand", { sequence: 1 });
    await expect(client.threads.archive("thread-1" as never)).resolves.toBeUndefined();

    server.token = "token-2";
    await client.auth.setAccessToken("token-2");
    expect(client.auth.credentialsVersion).toBe(1);
    await server.waitForConnections(2);
    await client.connect();
    expect(server.upgrades).toHaveLength(2);
    expect(server.upgrades[1]?.accepted).toBe(true);
    await expect(client.threads.archive("thread-1" as never)).rejects.toMatchObject({
      code: "insufficient_scope",
      requiredScope: "orchestration:operate",
    });
    await expect(client.rpc.call("server.probe", {})).resolves.toBeDefined();

    // Storing the same token again is a no-op: no reconnect.
    await client.auth.setAccessToken("token-2");
    expect(client.auth.credentialsVersion).toBe(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(server.upgrades).toHaveLength(2);
  });

  it("checks scopes locally once the credential's scopes are known", async () => {
    client = T3Client.create({
      baseUrl: server.httpUrl,
      credentials: memoryCredentialStore({
        accessToken: "token-1",
        scopes: ["orchestration:read"],
      }),
      fetch: server.fetch,
      webSocket,
    });
    await client.connect();
    await expect(client.threads.archive("thread-1" as never)).rejects.toMatchObject({
      code: "insufficient_scope",
      requiredScope: "orchestration:operate",
    });
  });

  it("refuses both credentials and accessToken", () => {
    expect(() =>
      T3Client.create({
        baseUrl: server.httpUrl,
        credentials: memoryCredentialStore(),
        accessToken: "token-1",
      }),
    ).toThrow(/either credentials or accessToken/);
  });
});
