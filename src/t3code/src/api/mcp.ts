import type { z } from "zod";

import { T3PreconditionError } from "../errors.js";
import {
  ExternalMcpClear,
  ExternalMcpRegistration,
  type ExternalMcpClear as ExternalMcpClearType,
  type ExternalMcpRegistration as ExternalMcpRegistrationType,
} from "../schemas/mcp.js";
import type { HttpTransport } from "../transport/http.js";

export class McpApi {
  constructor(readonly http: HttpTransport) {}

  async register(input: ExternalMcpRegistrationType): Promise<void> {
    const body = validate(ExternalMcpRegistration, input);
    await this.http.request({
      method: "PUT",
      path: "/api/mcp/provider-session",
      auth: "required",
      body,
      decode: "empty",
    });
  }

  async clear(input: ExternalMcpClearType): Promise<void> {
    const body = validate(ExternalMcpClear, input);
    await this.http.request({
      method: "DELETE",
      path: "/api/mcp/provider-session",
      auth: "required",
      body,
      decode: "empty",
    });
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

function validate<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue?.path.map(String).join(".") || "input";
  throw new T3PreconditionError(`${field} is invalid: ${issue?.message ?? "invalid value"}`);
}
