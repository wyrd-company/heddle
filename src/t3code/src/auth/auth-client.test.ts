import { describe, expect, it, vi } from "vitest";

import { T3AuthError } from "../errors.js";
import { authSessionId } from "../schemas/common.js";
import { HttpTransport } from "../transport/http.js";
import { AuthClient } from "./auth-client.js";
import { memoryCredentialStore } from "./credential-store.js";

const authDescriptor = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "session",
};

const sessionState = {
  authenticated: true,
  auth: authDescriptor,
  scopes: ["orchestration:read", "orchestration:operate", "access:read", "access:write"],
  sessionMethod: "bearer-access-token",
  expiresAt: "2030-01-02T03:04:05.000Z",
};

describe("AuthClient", () => {
  it("uses every auth HTTP route and stores an exchanged credential", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path === "/.well-known/t3/environment") {
        return json({
          environmentId: "environment-1",
          label: "Sample environment",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "1.2.3",
          capabilities: { repositoryIdentity: true, futureCapability: true },
        });
      }
      if (path === "/api/auth/session") return json(sessionState);
      if (path === "/oauth/token") {
        expect(await request.text()).toContain("client_label=automation");
        return json({
          access_token: "credential-2",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "orchestration:read access:read",
        });
      }
      if (path === "/api/auth/websocket-ticket") {
        return json({ ticket: "ticket-1", expiresAt: "2030-01-02T03:04:05.000Z" });
      }
      if (path === "/api/auth/pairing-token") {
        return json({
          id: "pairing-1",
          credential: "single-use-1",
          label: "Sample client",
          expiresAt: "2030-01-02T03:04:05.000Z",
        });
      }
      if (path === "/api/auth/pairing-links/revoke") return json({ revoked: true });
      if (path === "/api/auth/pairing-links") {
        return json([
          {
            id: "pairing-1",
            scopes: ["orchestration:read"],
            subject: "subject-1",
            createdAt: "2030-01-01T03:04:05.000Z",
            expiresAt: "2030-01-02T03:04:05.000Z",
          },
        ]);
      }
      if (path === "/api/auth/clients/revoke-others") return json({ revokedCount: 2 });
      if (path === "/api/auth/clients/revoke") return json({ revoked: true });
      if (path === "/api/auth/clients") {
        return json([
          {
            sessionId: "session-1",
            subject: "subject-1",
            scopes: ["orchestration:read"],
            method: "bearer-access-token",
            client: { deviceType: "bot", label: "Sample client" },
            issuedAt: "2030-01-01T03:04:05.000Z",
            expiresAt: "2030-01-02T03:04:05.000Z",
            lastConnectedAt: null,
            connected: false,
            current: true,
          },
        ]);
      }
      return new Response("missing fixture", { status: 500 });
    });
    const store = memoryCredentialStore({ accessToken: "credential-1" });
    const client = makeClient(fetch, store);

    await expect(client.descriptor()).resolves.toMatchObject({ environmentId: "environment-1" });
    await expect(client.sessionState()).resolves.toMatchObject({ authenticated: true });
    await expect(
      client.exchangePairingToken("pairing-token-1", {
        scopes: ["orchestration:read", "access:read"],
        clientLabel: "automation",
        clientDeviceType: "bot",
        clientOs: "linux",
      }),
    ).resolves.toMatchObject({ access_token: "credential-2" });
    expect(await store.load()).toEqual({
      accessToken: "credential-2",
      scopes: ["orchestration:read", "access:read"],
      expiresAt: "2029-12-31T01:00:00.000Z",
      sessionMethod: "bearer-access-token",
    });
    await expect(client.setAccessToken("credential-3")).resolves.toMatchObject({
      authenticated: true,
    });
    await expect(client.websocketTicket()).resolves.toMatchObject({ ticket: "ticket-1" });
    await expect(
      client.createPairingCredential({ label: "Sample client", scopes: ["orchestration:read"] }),
    ).resolves.toMatchObject({ id: "pairing-1" });
    await expect(client.listPairingLinks()).resolves.toHaveLength(1);
    await expect(client.revokePairingLink("pairing-1")).resolves.toBe(true);
    await expect(client.listClients()).resolves.toHaveLength(1);
    await expect(client.revokeClient(authSessionId("session-1"))).resolves.toBe(true);
    await expect(client.revokeOtherClients()).resolves.toBe(2);
    await expect(client.hasScope("access:write")).resolves.toBe(true);
    await expect(client.ensureScopes(["orchestration:read"])).resolves.toBeUndefined();

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/.well-known/t3/environment",
      "/api/auth/session",
      "/oauth/token",
      "/api/auth/session",
      "/api/auth/websocket-ticket",
      "/api/auth/pairing-token",
      "/api/auth/pairing-links",
      "/api/auth/pairing-links/revoke",
      "/api/auth/clients",
      "/api/auth/clients/revoke",
      "/api/auth/clients/revoke-others",
    ]);
  });

  it("stores a scope it does not know and reports it through scopesSync", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      if (path === "/oauth/token") {
        return json({
          access_token: "credential-2",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "orchestration:read future:scope",
        });
      }
      return json({ ...sessionState, scopes: ["access:read", "future:scope"] });
    });
    const store = memoryCredentialStore();
    const client = makeClient(fetch, store);
    const changes: number[] = [];
    client.onCredentialsChange(() => changes.push(client.credentialsVersion));
    expect(client.scopesSync()).toBeUndefined();

    await client.exchangePairingToken("pairing-token-1");
    expect(await store.load()).toMatchObject({ scopes: ["orchestration:read", "future:scope"] });
    expect(client.scopesSync()).toEqual(["orchestration:read", "future:scope"]);
    await expect(client.hasScope("orchestration:read")).resolves.toBe(true);
    await expect(client.hasScope("access:read")).resolves.toBe(false);

    await client.setAccessToken("credential-3");
    expect(client.scopesSync()).toEqual(["access:read", "future:scope"]);
    await client.setAccessToken("credential-3");
    await client.clearCredentials();
    expect(client.scopesSync()).toBeUndefined();
    await expect(store.load()).resolves.toEqual({});
    expect(changes).toEqual([1, 2, 3]);
  });

  it("does not store a candidate token for an unauthenticated session", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({ authenticated: false, auth: authDescriptor }),
    );
    const store = memoryCredentialStore({ accessToken: "credential-original" });
    const client = makeClient(fetch, store);
    await expect(client.setAccessToken("credential-candidate")).rejects.toBeInstanceOf(T3AuthError);
    await expect(store.load()).resolves.toEqual({ accessToken: "credential-original" });
  });
});

function makeClient(
  fetch: typeof globalThis.fetch,
  store: ReturnType<typeof memoryCredentialStore>,
): AuthClient {
  const transport = new HttpTransport({
    baseUrl: "https://example.invalid",
    fetch,
    getAccessToken: async () => (await store.load()).accessToken,
  });
  return new AuthClient(transport, store, { now: () => new Date("2029-12-31T00:00:00.000Z") });
}

function json(value: unknown): Response {
  return Response.json(value);
}
