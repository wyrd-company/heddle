/**
 * The shape of one entry in the RPC method registry. The registry
 * (`registry.ts`) is assembled from `methods/*.ts`; the typed client
 * (`client.ts`) is generic over any table of these specs, so the two can be
 * built and tested independently.
 */
import type { z } from "zod";

export type AuthEnvironmentScope =
  | "orchestration:read"
  | "orchestration:operate"
  | "terminal:operate"
  | "review:write"
  | "access:read"
  | "access:write"
  | "relay:read"
  | "relay:write";

export interface RpcMethodSpec<Payload = unknown, Success = unknown> {
  /** Validates and normalises what the caller passes before it is sent. */
  readonly payload: z.ZodType<Payload, unknown>;
  /** Decodes each `Exit` success value (unary) or each `Chunk` item (stream). */
  readonly success: z.ZodType<Success, unknown>;
  /** `true` when the server answers with `Chunk`s until an `Exit`. */
  readonly stream: boolean;
  /** Scope the server requires; checked locally when the session's scopes are known. */
  readonly scope: AuthEnvironmentScope;
}

export type RpcMethodTable = Readonly<Record<string, RpcMethodSpec>>;

export type UnaryMethodName<Table extends RpcMethodTable> = {
  [K in keyof Table & string]: Table[K] extends { readonly stream: false } ? K : never;
}[keyof Table & string];

export type StreamMethodName<Table extends RpcMethodTable> = {
  [K in keyof Table & string]: Table[K] extends { readonly stream: true } ? K : never;
}[keyof Table & string];

export type RpcPayload<Table extends RpcMethodTable, M extends keyof Table> =
  Table[M] extends RpcMethodSpec<infer P, unknown> ? P : never;

export type RpcSuccess<Table extends RpcMethodTable, M extends keyof Table> =
  Table[M] extends RpcMethodSpec<unknown, infer S> ? S : never;

export function defineMethod<Payload, Success, const Stream extends boolean>(spec: {
  readonly payload: z.ZodType<Payload, unknown>;
  readonly success: z.ZodType<Success, unknown>;
  readonly stream: Stream;
  readonly scope: AuthEnvironmentScope;
}): RpcMethodSpec<Payload, Success> & { readonly stream: Stream } {
  return spec;
}
