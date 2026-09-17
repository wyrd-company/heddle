import { describe, expect, it } from "vitest";

import { hasScope } from "../auth/scopes.js";
import {
  AuthAdministrativeScopes,
  AuthClientSession,
  AuthCreatePairingCredentialInput,
  AuthEnvironmentScope,
  AuthPairingLink,
  AuthSessionState,
  AuthStandardClientScopes,
} from "./auth.js";

const authDescriptor = {
  policy: "loopback-browser",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "session",
  futureField: true,
};

describe("auth schemas", () => {
  it("keeps the eight scopes strict for caller input and descriptors loose", () => {
    expect(AuthEnvironmentScope.options).toHaveLength(8);
    expect(AuthEnvironmentScope.safeParse("future:scope").success).toBe(false);
    expect(AuthCreatePairingCredentialInput.safeParse({ scopes: ["future:scope"] }).success).toBe(
      false,
    );
    expect(AuthStandardClientScopes).toHaveLength(5);
    expect(AuthAdministrativeScopes).toHaveLength(8);
    expect(
      AuthSessionState.parse({ authenticated: false, auth: authDescriptor, futureField: true }),
    ).toMatchObject({ futureField: true });
  });

  it("decodes a scope this client does not know in every server output", () => {
    const state = AuthSessionState.parse({
      authenticated: true,
      auth: authDescriptor,
      scopes: ["orchestration:read", "future:scope"],
    });
    expect(state.scopes).toEqual(["orchestration:read", "future:scope"]);
    expect(hasScope(state.scopes, "orchestration:read")).toBe(true);
    expect(hasScope(state.scopes, "orchestration:operate")).toBe(false);

    const link = AuthPairingLink.parse({
      id: "pairing-1",
      scopes: ["future:scope"],
      subject: "subject-1",
      createdAt: "2030-01-01T00:00:00.000Z",
      expiresAt: "2030-01-02T00:00:00.000Z",
    });
    expect(link.scopes).toEqual(["future:scope"]);

    const session = AuthClientSession.parse({
      sessionId: "session-1",
      subject: "subject-1",
      scopes: ["access:read", "future:scope"],
      method: "bearer-access-token",
      client: { deviceType: "bot" },
      issuedAt: "2030-01-01T00:00:00.000Z",
      expiresAt: "2030-01-02T00:00:00.000Z",
      lastConnectedAt: null,
      connected: false,
      current: true,
    });
    expect(session.scopes).toContain("future:scope");
  });
});
