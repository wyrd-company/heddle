import { z } from "zod";

import {
  AuthSessionId,
  ClientSurface,
  IsoDateTime,
  TrimmedNonEmptyString,
  forwardCompatibleLiteral,
  type KnownOr,
} from "./common.js";

export const ServerAuthPolicy = z.enum([
  "desktop-managed-local",
  "loopback-browser",
  "remote-reachable",
  "unsafe-no-auth",
]);
export type ServerAuthPolicy = z.infer<typeof ServerAuthPolicy>;

export const ServerAuthBootstrapMethod = z.enum(["desktop-bootstrap", "one-time-token"]);
export type ServerAuthBootstrapMethod = z.infer<typeof ServerAuthBootstrapMethod>;

export const ServerAuthSessionMethod = z.enum([
  "browser-session-cookie",
  "bearer-access-token",
  "dpop-access-token",
]);
export type ServerAuthSessionMethod = z.infer<typeof ServerAuthSessionMethod>;

const authEnvironmentScopes = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "access:read",
  "access:write",
  "relay:read",
  "relay:write",
] as const;

/** Strict: validates the scopes a caller asks for. */
export const AuthEnvironmentScope = z.enum(authEnvironmentScopes);
export type AuthEnvironmentScope = z.infer<typeof AuthEnvironmentScope>;

/**
 * A scope as the server reports it (session state, token exchange, pairing
 * links, client sessions). The strict enum above validates what a caller
 * asks for; a newer server may grant a scope this client has not heard of,
 * and that must decode rather than fail.
 */
export const AuthGrantedScope = forwardCompatibleLiteral(authEnvironmentScopes);
export type AuthGrantedScope = KnownOr<AuthEnvironmentScope>;

export const AuthStandardClientScopes = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "relay:read",
] as const satisfies readonly AuthEnvironmentScope[];

export const AuthAdministrativeScopes = [
  ...AuthStandardClientScopes,
  "access:read",
  "access:write",
  "relay:write",
] as const satisfies readonly AuthEnvironmentScope[];

export const ServerAuthDescriptor = z.looseObject({
  policy: ServerAuthPolicy,
  bootstrapMethods: z.array(ServerAuthBootstrapMethod),
  sessionMethods: z.array(ServerAuthSessionMethod),
  sessionCookieName: TrimmedNonEmptyString,
});
export type ServerAuthDescriptor = z.infer<typeof ServerAuthDescriptor>;

export const AuthSessionState = z.looseObject({
  authenticated: z.boolean(),
  auth: ServerAuthDescriptor,
  scopes: z.array(AuthGrantedScope).optional(),
  sessionMethod: ServerAuthSessionMethod.optional(),
  expiresAt: IsoDateTime.optional(),
});
export type AuthSessionState = z.infer<typeof AuthSessionState>;

export const AuthAccessTokenResult = z.looseObject({
  access_token: TrimmedNonEmptyString,
  issued_token_type: z.literal("urn:ietf:params:oauth:token-type:access_token"),
  token_type: z.enum(["Bearer", "DPoP"]),
  expires_in: z.number(),
  scope: TrimmedNonEmptyString,
});
export type AuthAccessTokenResult = z.infer<typeof AuthAccessTokenResult>;

export const AuthWebSocketTicketResult = z.looseObject({
  ticket: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type AuthWebSocketTicketResult = z.infer<typeof AuthWebSocketTicketResult>;

export const AuthPairingCredentialResult = z.looseObject({
  id: TrimmedNonEmptyString,
  credential: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString.optional(),
  expiresAt: IsoDateTime,
});
export type AuthPairingCredentialResult = z.infer<typeof AuthPairingCredentialResult>;

export const AuthPairingLink = z.looseObject({
  id: TrimmedNonEmptyString,
  scopes: z.array(AuthGrantedScope),
  subject: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString.optional(),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type AuthPairingLink = z.infer<typeof AuthPairingLink>;

export const AuthClientMetadataDeviceType = z.enum([
  "desktop",
  "mobile",
  "tablet",
  "bot",
  "unknown",
]);
export type AuthClientMetadataDeviceType = z.infer<typeof AuthClientMetadataDeviceType>;

export const AuthClientMetadata = z.looseObject({
  label: TrimmedNonEmptyString.optional(),
  ipAddress: TrimmedNonEmptyString.optional(),
  userAgent: TrimmedNonEmptyString.optional(),
  deviceType: AuthClientMetadataDeviceType,
  os: TrimmedNonEmptyString.optional(),
  browser: TrimmedNonEmptyString.optional(),
});
export type AuthClientMetadata = z.infer<typeof AuthClientMetadata>;

export const AuthClientSession = z.looseObject({
  sessionId: AuthSessionId,
  subject: TrimmedNonEmptyString,
  scopes: z.array(AuthGrantedScope),
  method: ServerAuthSessionMethod,
  client: AuthClientMetadata,
  issuedAt: IsoDateTime,
  expiresAt: IsoDateTime,
  lastConnectedAt: IsoDateTime.nullable(),
  connected: z.boolean(),
  current: z.boolean(),
});
export type AuthClientSession = z.infer<typeof AuthClientSession>;

export const AuthCreatePairingCredentialInput = z.looseObject({
  label: TrimmedNonEmptyString.optional(),
  scopes: z.array(AuthEnvironmentScope).optional(),
});
export type AuthCreatePairingCredentialInput = z.infer<typeof AuthCreatePairingCredentialInput>;

export const ClientMetadataSurface = ClientSurface;
export type ClientMetadataSurface = z.infer<typeof ClientMetadataSurface>;
