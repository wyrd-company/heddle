/**
 * RpcClient: typed `call` and `stream` over an RpcConnection, driven by a
 * method table. Payloads are validated before they are sent, success values
 * are decoded on the way back, and the credential's scopes are checked
 * locally when they are known. `callRaw` and `streamRaw` bypass the table.
 */
import type { z } from "zod";
import { T3AuthError, T3DecodeError, T3PreconditionError } from "../errors.js";
import { noopLogger, type Logger } from "../internal/logger.js";
import type { RpcConnection, RpcStreamOptions } from "../transport/rpc-connection.js";
import type {
  RpcMethodSpec,
  RpcMethodTable,
  RpcPayload,
  RpcSuccess,
  StreamMethodName,
  UnaryMethodName,
} from "./spec.js";

export type { RpcStreamOptions } from "../transport/rpc-connection.js";

export type StreamItem<T> =
  | { readonly kind: "item"; readonly value: T }
  | { readonly kind: "decode-error"; readonly error: T3DecodeError };

export interface RpcClientOptions {
  /** The scopes of the current credential, or `undefined` when unknown (no local check). */
  readonly getScopes?: () => readonly string[] | undefined;
  readonly logger?: Logger;
}

export class RpcClient<Table extends RpcMethodTable> {
  readonly #connection: RpcConnection;
  readonly #table: Table;
  readonly #getScopes: () => readonly string[] | undefined;
  readonly #logger: Logger;

  constructor(connection: RpcConnection, table: Table, options: RpcClientOptions = {}) {
    this.#connection = connection;
    this.#table = table;
    this.#getScopes = options.getScopes ?? (() => undefined);
    this.#logger = options.logger ?? noopLogger;
  }

  get connection(): RpcConnection {
    return this.#connection;
  }

  /** `true` when the table has an entry for `method`. */
  has(method: string): method is keyof Table & string {
    return Object.hasOwn(this.#table, method);
  }

  async call<M extends UnaryMethodName<Table>>(
    method: M,
    payload: RpcPayload<Table, M>,
    signal?: AbortSignal,
  ): Promise<RpcSuccess<Table, M>> {
    const spec = this.#spec(method);
    const encoded = this.#preparePayload(method, spec, payload);
    const raw = await this.#connection.call(method, encoded, signal);
    const result = spec.success.safeParse(raw);
    if (!result.success) throw new T3DecodeError(method, result.error, raw);
    return result.data as RpcSuccess<Table, M>;
  }

  stream<M extends StreamMethodName<Table>>(
    method: M,
    payload: RpcPayload<Table, M>,
    options?: RpcStreamOptions,
  ): AsyncIterable<StreamItem<RpcSuccess<Table, M>>> {
    const connection = this.#connection;
    const logger = this.#logger;
    const prepare = () => {
      const spec = this.#spec(method);
      return { spec, encoded: this.#preparePayload(method, spec, payload) };
    };
    return {
      // Validation errors surface on the first `next()`, like every other stream failure.
      async *[Symbol.asyncIterator]() {
        const { spec, encoded } = prepare();
        for await (const raw of connection.stream(method, encoded, options)) {
          const result = spec.success.safeParse(raw);
          if (result.success) {
            yield { kind: "item", value: result.data as RpcSuccess<Table, M> };
          } else {
            const error = new T3DecodeError(method, result.error, raw);
            logger.warn("Stream item could not be decoded; continuing.", {
              method,
              message: error.message,
            });
            yield { kind: "decode-error", error };
          }
        }
      },
    };
  }

  /** Any method by tag, no validation, no decoding. */
  callRaw(tag: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.#connection.call(tag, payload, signal);
  }

  streamRaw(tag: string, payload: unknown, options?: RpcStreamOptions): AsyncIterable<unknown> {
    return this.#connection.stream(tag, payload, options);
  }

  #spec(method: string): RpcMethodSpec {
    const spec = this.#table[method];
    if (!spec) throw new T3PreconditionError(`${method} is not a registered RPC method.`);
    return spec;
  }

  /** Scope check, then validation and normalisation through the payload schema. */
  #preparePayload(method: string, spec: RpcMethodSpec, payload: unknown): unknown {
    const scopes = this.#getScopes();
    if (scopes && !scopes.includes(spec.scope)) {
      throw T3AuthError.insufficientScope(spec.scope, method);
    }
    const result = spec.payload.safeParse(payload);
    if (!result.success) {
      throw new T3PreconditionError(
        `${method} payload is invalid: ${summarizeIssues(result.error)}`,
        { cause: result.error },
      );
    }
    return result.data;
  }
}

function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join(".") || "$"}: ${issue.message}`)
    .join("; ");
}
