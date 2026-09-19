import type { z } from "zod";

import {
  T3AuthError,
  T3ConnectionError,
  T3DecodeError,
  T3Error,
  T3HttpError,
  T3NotFoundError,
  T3PreconditionError,
  type T3HttpErrorDetails,
} from "../errors.js";

export interface HttpTransportOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  getAccessToken: () => Promise<string | undefined>;
  userAgent?: string;
}

export interface HttpRequest<T> {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown | URLSearchParams;
  auth?: "required" | "optional" | "none";
  decode: z.ZodType<T> | "empty";
  signal?: AbortSignal;
}

export class HttpTransport {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #getAccessToken: () => Promise<string | undefined>;
  readonly #userAgent: string | undefined;

  constructor(options: HttpTransportOptions) {
    this.#baseUrl = options.baseUrl;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#getAccessToken = options.getAccessToken;
    this.#userAgent = options.userAgent;
  }

  request<T>(request: HttpRequest<T>): Promise<T> {
    return this.#request(request, undefined, false);
  }

  /** Auth control-plane hook for validating a candidate token before it is stored. */
  requestWithAccessToken<T>(request: HttpRequest<T>, accessToken: string): Promise<T> {
    return this.#request(request, accessToken, true);
  }

  async #request<T>(
    request: HttpRequest<T>,
    accessTokenOverride: string | undefined,
    hasOverride: boolean,
  ): Promise<T> {
    let url: URL;
    try {
      url = new URL(request.path, this.#baseUrl);
    } catch (cause) {
      throw new T3PreconditionError(`Invalid HTTP URL for ${request.path}.`, { cause });
    }
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const auth = request.auth ?? "none";
    let accessToken = accessTokenOverride;
    if (!hasOverride && auth !== "none") {
      try {
        accessToken = await this.#getAccessToken();
      } catch (cause) {
        if (cause instanceof T3Error) throw cause;
        throw new T3ConnectionError("open_failed", "Could not load the HTTP credential.", {
          cause,
        });
      }
    }
    if (auth === "required" && accessToken === undefined) {
      throw new T3AuthError("This request requires an access token.", {
        code: "auth_invalid",
        status: 401,
        method: "LOCAL",
        path: request.path,
        body: undefined,
        reason: "missing_credential",
      });
    }

    const headers = new Headers();
    if (accessToken !== undefined && auth !== "none") {
      headers.set("authorization", `Bearer ${accessToken}`);
    }
    if (this.#userAgent !== undefined) headers.set("user-agent", this.#userAgent);
    let body: RequestInit["body"] | undefined;
    if (request.body instanceof URLSearchParams) {
      headers.set("content-type", "application/x-www-form-urlencoded");
      body = request.body;
    } else if (request.body !== undefined) {
      headers.set("content-type", "application/json");
      try {
        body = JSON.stringify(request.body);
      } catch (cause) {
        throw new T3PreconditionError(
          `${request.method} ${request.path} could not encode its JSON body.`,
          { cause },
        );
      }
    }

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (cause) {
      throw new T3ConnectionError(
        "open_failed",
        `${request.method} ${request.path} could not reach the server.`,
        { cause },
      );
    }

    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      throw new T3ConnectionError(
        "open_failed",
        `${request.method} ${request.path} could not read the server response.`,
        { cause },
      );
    }
    const raw = parseBody(text);
    if (!response.ok) throw httpError(response.status, request, raw);
    if (request.decode === "empty") return undefined as T;

    const decoded = request.decode.safeParse(raw);
    if (!decoded.success) {
      throw new T3DecodeError(`${request.method} ${request.path}`, decoded.error, raw);
    }
    return decoded.data;
  }
}

function parseBody(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function httpError<T>(status: number, request: HttpRequest<T>, body: unknown): T3HttpError {
  const record = asRecord(body);
  const tag = stringField(record, "_tag");
  const reason = stringField(record, "reason") ?? stringField(record, "error");
  const traceId = stringField(record, "traceId");
  const requiredScope = stringField(record, "requiredScope");
  const details: T3HttpErrorDetails = {
    status,
    method: request.method,
    path: request.path,
    body,
    ...(tag === undefined ? {} : { tag }),
    ...(reason === undefined ? {} : { reason }),
    ...(traceId === undefined ? {} : { traceId }),
  };
  const message = `${request.method} ${request.path} failed with HTTP ${status}${reason ? ` (${reason})` : ""}.`;
  if (status === 401) return new T3AuthError(message, { ...details, code: "auth_invalid" });
  if (status === 403) {
    return new T3AuthError(message, {
      ...details,
      code: "insufficient_scope",
      ...(requiredScope === undefined ? {} : { requiredScope }),
    });
  }
  if (status === 404) return new T3NotFoundError(message, details);
  return new T3HttpError(message, details);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}
