import type { z } from "zod";

import { T3AuthError, T3NotFoundError, T3PreconditionError } from "../errors.js";
import {
  ExternalMcpClear,
  ExternalMcpProviderSession,
  ExternalMcpProviderSessionQuery,
  ExternalMcpRegistration,
  type ExternalMcpClear as ExternalMcpClearType,
  type ExternalMcpProviderSessionQuery as ExternalMcpProviderSessionQueryType,
  type ExternalMcpRegistration as ExternalMcpRegistrationType,
} from "../schemas/mcp.js";
import type { HttpTransport } from "../transport/http.js";

const PROVIDER_SESSION_PATH = "/api/mcp/provider-session";
const PROVIDER_SESSION_SCOPE = "orchestration:operate";

export class McpApi {
  constructor(readonly http: HttpTransport) {}

  async register(input: ExternalMcpRegistrationType): Promise<void> {
    const body = validate(ExternalMcpRegistration, input);
    await this.http.request({
      method: "PUT",
      path: PROVIDER_SESSION_PATH,
      auth: "required",
      body,
      decode: "empty",
    });
  }

  async clear(input: ExternalMcpClearType): Promise<void> {
    const body = validate(ExternalMcpClear, input);
    await this.http.request({
      method: "DELETE",
      path: PROVIDER_SESSION_PATH,
      auth: "required",
      body,
      decode: "empty",
    });
  }

  /**
   * The native harness session identity of a thread's provider session, exactly
   * as the harness reports it. `null` when the thread is unknown, has no
   * provider session, or its identity is not known yet.
   */
  async nativeSessionId(input: ExternalMcpProviderSessionQueryType): Promise<string | null> {
    const query = validate(ExternalMcpProviderSessionQuery, input);
    try {
      const result = await this.http.request({
        method: "GET",
        path: PROVIDER_SESSION_PATH,
        query: { threadId: query.threadId },
        auth: "required",
        decode: ExternalMcpProviderSession,
      });
      return result.nativeSessionId;
    } catch (error) {
      if (error instanceof T3NotFoundError) return null;
      throw error instanceof T3AuthError ? scopeError(error) : error;
    }
  }

  /**
   * The server has no readable external-registration registry. This validated
   * PUT replaces the entry for the same `(threadId, name)` and takes effect
   * when the provider session next starts.
   */
  ensureRegistration(input: ExternalMcpRegistrationType): Promise<void> {
    return this.register(input);
  }

  async withRegistration<T>(input: ExternalMcpRegistrationType, run: () => Promise<T>): Promise<T> {
    await this.register(input);
    try {
      return await run();
    } finally {
      await this.clear({
        threadId: input.threadId,
        ...(input.name === undefined ? {} : { name: input.name }),
      });
    }
  }
}

function scopeError(error: T3AuthError): T3AuthError {
  return new T3AuthError(
    `GET ${PROVIDER_SESSION_PATH} was refused with HTTP ${String(error.status)}; it needs the ${error.requiredScope ?? PROVIDER_SESSION_SCOPE} scope.`,
    {
      status: error.status,
      method: error.method,
      path: error.path,
      body: error.body,
      code: error.code,
      ...(error.tag === undefined ? {} : { tag: error.tag }),
      ...(error.reason === undefined ? {} : { reason: error.reason }),
      ...(error.traceId === undefined ? {} : { traceId: error.traceId }),
      requiredScope: error.requiredScope ?? PROVIDER_SESSION_SCOPE,
    },
    { cause: error },
  );
}

function validate<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue?.path.map(String).join(".") || "input";
  throw new T3PreconditionError(`${field} is invalid: ${issue?.message ?? "invalid value"}`);
}
