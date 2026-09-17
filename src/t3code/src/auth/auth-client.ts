/**
 * AuthClient: the auth control plane over HTTP, and the only module that
 * reads or writes the credential store. It keeps an in-memory copy of the
 * last credentials it loaded or saved so the RPC layer can check scopes
 * without a store round trip, and it tells subscribers when the stored
 * credential changes so an open socket can re-authenticate.
 */
import { z } from "zod";

import { T3AuthError, T3PreconditionError } from "../errors.js";
import type { Clock } from "../internal/clock.js";
import { systemClock } from "../internal/clock.js";
import {
  AuthAccessTokenResult,
  AuthClientSession,
  AuthCreatePairingCredentialInput,
  AuthPairingCredentialResult,
  AuthPairingLink,
  AuthSessionState,
  AuthWebSocketTicketResult,
  type AuthAccessTokenResult as AuthAccessTokenResultType,
  type AuthClientMetadataDeviceType as AuthClientMetadataDeviceTypeType,
  type AuthClientSession as AuthClientSessionType,
  type AuthCreatePairingCredentialInput as AuthCreatePairingCredentialInputType,
  type AuthEnvironmentScope as AuthEnvironmentScopeType,
  type AuthGrantedScope as AuthGrantedScopeType,
  type AuthPairingCredentialResult as AuthPairingCredentialResultType,
  type AuthPairingLink as AuthPairingLinkType,
  type AuthSessionState as AuthSessionStateType,
  type AuthWebSocketTicketResult as AuthWebSocketTicketResultType,
} from "../schemas/auth.js";
import type { AuthSessionId } from "../schemas/common.js";
import {
  ExecutionEnvironmentDescriptor,
  type ExecutionEnvironmentDescriptor as ExecutionEnvironmentDescriptorType,
} from "../schemas/environment.js";
import type { HttpTransport } from "../transport/http.js";
import type { CredentialStore, StoredCredentials } from "./credential-store.js";
import { ensureScopes as requireScopes, hasScope as includesScope } from "./scopes.js";

export interface ExchangePairingTokenOptions {
  scopes?: AuthEnvironmentScopeType[];
  clientLabel?: string;
  clientDeviceType?: AuthClientMetadataDeviceTypeType;
  clientOs?: string;
}

const BooleanRevoked = z.looseObject({ revoked: z.boolean() });
const RevokedCount = z.looseObject({ revokedCount: z.number() });

export class AuthClient {
  #cached: StoredCredentials | undefined;
  #version = 0;
  readonly #changeHandlers = new Set<() => void>();

  constructor(
    readonly http: HttpTransport,
    readonly credentials: CredentialStore,
    readonly clock: Clock = systemClock,
  ) {}

  /** Increments every time this client saves or clears a different credential. */
  get credentialsVersion(): number {
    return this.#version;
  }

  /** Called after every change to the stored credential made through this client. */
  onCredentialsChange(handler: () => void): () => void {
    this.#changeHandlers.add(handler);
    return () => this.#changeHandlers.delete(handler);
  }

  /** Scopes of the last credential loaded or saved; `undefined` until one is known. */
  scopesSync(): AuthGrantedScopeType[] | undefined {
    const scopes = this.#cached?.scopes;
    return scopes === undefined ? undefined : [...scopes];
  }

  descriptor(signal?: AbortSignal): Promise<ExecutionEnvironmentDescriptorType> {
    return this.http.request({
      method: "GET",
      path: "/.well-known/t3/environment",
      auth: "none",
      decode: ExecutionEnvironmentDescriptor,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  sessionState(signal?: AbortSignal): Promise<AuthSessionStateType> {
    return this.http.request({
      method: "GET",
      path: "/api/auth/session",
      auth: "optional",
      decode: AuthSessionState,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async exchangePairingToken(
    pairingToken: string,
    options: ExchangePairingTokenOptions = {},
  ): Promise<AuthAccessTokenResultType> {
    if (pairingToken.trim().length === 0) {
      throw new T3PreconditionError("pairingToken must not be empty.");
    }
    const form = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: pairingToken,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    });
    if (options.scopes !== undefined) form.set("scope", options.scopes.join(" "));
    if (options.clientLabel !== undefined) form.set("client_label", options.clientLabel);
    if (options.clientDeviceType !== undefined) {
      form.set("client_device_type", options.clientDeviceType);
    }
    if (options.clientOs !== undefined) form.set("client_os", options.clientOs);

    const result = await this.http.request({
      method: "POST",
      path: "/oauth/token",
      auth: "none",
      body: form,
      decode: AuthAccessTokenResult,
    });
    await this.#save({
      accessToken: result.access_token,
      scopes: splitScopes(result.scope),
      expiresAt: new Date(this.clock.now().getTime() + result.expires_in * 1_000).toISOString(),
      sessionMethod: result.token_type === "Bearer" ? "bearer-access-token" : "dpop-access-token",
    });
    return result;
  }

  async setAccessToken(token: string): Promise<AuthSessionStateType> {
    if (token.trim().length === 0) throw new T3PreconditionError("token must not be empty.");
    const state = await this.http.requestWithAccessToken(
      { method: "GET", path: "/api/auth/session", auth: "required", decode: AuthSessionState },
      token,
    );
    if (!state.authenticated) {
      throw new T3AuthError("The supplied access token did not authenticate a session.", {
        code: "auth_invalid",
        status: 401,
        method: "GET",
        path: "/api/auth/session",
        body: state,
        reason: "invalid_credential",
      });
    }
    await this.#save(credentialsFromState(token, state));
    return state;
  }

  /** Forgets the stored credential. */
  async clearCredentials(): Promise<void> {
    await this.credentials.clear();
    this.#remember({});
  }

  websocketTicket(signal?: AbortSignal): Promise<AuthWebSocketTicketResultType> {
    return this.http.request({
      method: "POST",
      path: "/api/auth/websocket-ticket",
      auth: "required",
      decode: AuthWebSocketTicketResult,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  createPairingCredential(
    input: AuthCreatePairingCredentialInputType,
  ): Promise<AuthPairingCredentialResultType> {
    const body = parseInput(AuthCreatePairingCredentialInput, input, "pairing credential input");
    return this.http.request({
      method: "POST",
      path: "/api/auth/pairing-token",
      auth: "required",
      body,
      decode: AuthPairingCredentialResult,
    });
  }

  listPairingLinks(): Promise<AuthPairingLinkType[]> {
    return this.http.request({
      method: "GET",
      path: "/api/auth/pairing-links",
      auth: "required",
      decode: z.array(AuthPairingLink),
    });
  }

  async revokePairingLink(id: string): Promise<boolean> {
    const result = await this.http.request({
      method: "POST",
      path: "/api/auth/pairing-links/revoke",
      auth: "required",
      body: { id },
      decode: BooleanRevoked,
    });
    return result.revoked;
  }

  listClients(): Promise<AuthClientSessionType[]> {
    return this.http.request({
      method: "GET",
      path: "/api/auth/clients",
      auth: "required",
      decode: z.array(AuthClientSession),
    });
  }

  async revokeClient(sessionId: AuthSessionId): Promise<boolean> {
    const result = await this.http.request({
      method: "POST",
      path: "/api/auth/clients/revoke",
      auth: "required",
      body: { sessionId },
      decode: BooleanRevoked,
    });
    return result.revoked;
  }

  async revokeOtherClients(): Promise<number> {
    const result = await this.http.request({
      method: "POST",
      path: "/api/auth/clients/revoke-others",
      auth: "required",
      decode: RevokedCount,
    });
    return result.revokedCount;
  }

  async currentAccessToken(): Promise<string | undefined> {
    return (await this.#load()).accessToken;
  }

  async currentScopes(): Promise<AuthGrantedScopeType[] | undefined> {
    await this.#load();
    return this.scopesSync();
  }

  async hasScope(scope: AuthEnvironmentScopeType): Promise<boolean> {
    return includesScope(await this.currentScopes(), scope);
  }

  async ensureScopes(required: AuthEnvironmentScopeType[]): Promise<void> {
    requireScopes(await this.currentScopes(), required, "authenticated operation");
  }

  async #load(): Promise<StoredCredentials> {
    const loaded = await this.credentials.load();
    this.#cached = loaded;
    return loaded;
  }

  async #save(next: StoredCredentials): Promise<void> {
    await this.credentials.save(next);
    this.#remember(next);
  }

  /** Records the credential this client now holds; a real change bumps the version. */
  #remember(next: StoredCredentials): void {
    const changed = this.#cached === undefined || !sameCredentials(this.#cached, next);
    this.#cached = next;
    if (!changed) return;
    this.#version += 1;
    for (const handler of this.#changeHandlers) handler();
  }
}

/** The token exchange reports scopes as one space-separated string. */
function splitScopes(value: string): AuthGrantedScopeType[] {
  return value.split(/\s+/u).filter(Boolean);
}

function sameCredentials(a: StoredCredentials, b: StoredCredentials): boolean {
  return (
    a.accessToken === b.accessToken &&
    a.expiresAt === b.expiresAt &&
    a.sessionMethod === b.sessionMethod &&
    (a.scopes ?? []).join(" ") === (b.scopes ?? []).join(" ")
  );
}

function credentialsFromState(token: string, state: AuthSessionStateType): StoredCredentials {
  return {
    accessToken: token,
    ...(state.scopes === undefined ? {} : { scopes: [...state.scopes] }),
    ...(state.expiresAt === undefined ? {} : { expiresAt: state.expiresAt }),
    ...(state.sessionMethod === undefined ? {} : { sessionMethod: state.sessionMethod }),
  };
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown, name: string): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new T3PreconditionError(`${name} is invalid: ${result.error.message}`);
  return result.data;
}
