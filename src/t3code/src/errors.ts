/**
 * One error strategy for the whole library: every failure raised to a caller
 * is a `T3Error` with a stable `code`. Callers switch on `code` (or use
 * `instanceof`) and never inspect message text.
 */
import type { ZodError } from "zod";
import { redactSecrets } from "./internal/redact.js";

export type T3ErrorCode =
  | "http"
  | "auth_invalid"
  | "insufficient_scope"
  | "not_found"
  | "rpc_failed"
  | "rpc_defect"
  | "connection"
  | "decode"
  | "precondition"
  | "interrupted"
  | "timeout";

export abstract class T3Error extends Error {
  abstract readonly code: T3ErrorCode;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export interface T3HttpErrorDetails {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  /** Parsed JSON body when the server sent one, otherwise the raw text. Credential-shaped values are redacted. */
  readonly body: unknown;
  /** `_tag` of a tagged error body, when present. */
  readonly tag?: string;
  /** `reason` or `error` field of the body, when present. */
  readonly reason?: string;
  readonly traceId?: string;
}

/** A non-2xx HTTP response that is not one of the more specific classes below. */
export class T3HttpError extends T3Error {
  override readonly code: T3ErrorCode = "http";
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly tag: string | undefined;
  readonly reason: string | undefined;
  readonly traceId: string | undefined;

  constructor(message: string, details: T3HttpErrorDetails, options?: { cause?: unknown }) {
    super(message, options);
    this.status = details.status;
    this.method = details.method;
    this.path = details.path;
    this.body = redactSecrets(details.body);
    this.tag = details.tag;
    this.reason = details.reason;
    this.traceId = details.traceId;
  }
}

/** 401 (auth_invalid) or 403 (insufficient_scope), from HTTP or detected locally. */
export class T3AuthError extends T3HttpError {
  override readonly code: "auth_invalid" | "insufficient_scope";
  readonly requiredScope: string | undefined;

  constructor(
    message: string,
    details: T3HttpErrorDetails & {
      readonly code: "auth_invalid" | "insufficient_scope";
      readonly requiredScope?: string;
    },
    options?: { cause?: unknown },
  ) {
    super(message, details, options);
    this.code = details.code;
    this.requiredScope = details.requiredScope;
  }

  /** A scope check that failed before any request was sent. */
  static insufficientScope(requiredScope: string, context: string): T3AuthError {
    return new T3AuthError(`${context} needs the ${requiredScope} scope.`, {
      code: "insufficient_scope",
      requiredScope,
      status: 403,
      method: "LOCAL",
      path: context,
      body: undefined,
    });
  }
}

/** 404 from HTTP; `reason` names what was missing (for example `thread_not_found`). */
export class T3NotFoundError extends T3HttpError {
  override readonly code = "not_found" as const;
}

/** The server answered an RPC with a tagged failure (`Exit` → `Fail`). */
export class T3RpcError extends T3Error {
  readonly code = "rpc_failed" as const;
  readonly method: string;
  /** The server error's `_tag`, for example `OrchestrationDispatchCommandError`. */
  readonly tag: string;
  /** The whole decoded error record. */
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(method: string, error: { readonly _tag: string } & Record<string, unknown>) {
    const text = typeof error["message"] === "string" ? error["message"] : error._tag;
    super(`${method} failed: ${text}`);
    this.method = method;
    this.tag = error._tag;
    this.detail = error;
  }
}

/** The server died while handling an RPC (`Exit` → `Die`), often a payload decode failure. */
export class T3RpcDefectError extends T3Error {
  readonly code = "rpc_defect" as const;
  readonly method: string;
  readonly defect: unknown;

  constructor(method: string, defect: unknown) {
    super(`${method} hit a server defect: ${defectText(defect)}`);
    this.method = method;
    this.defect = defect;
  }
}

function defectText(defect: unknown): string {
  if (typeof defect === "string") return defect;
  if (defect && typeof defect === "object" && "message" in defect) {
    const m = (defect as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return JSON.stringify(defect) ?? String(defect);
}

export type T3ConnectionFailureReason = "closed" | "open_failed" | "ping_timeout" | "protocol";

/** The socket is not usable: it failed to open, closed, timed out, or spoke garbage. */
export class T3ConnectionError extends T3Error {
  readonly code = "connection" as const;
  readonly reason: T3ConnectionFailureReason;

  constructor(reason: T3ConnectionFailureReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.reason = reason;
  }
}

/** A server payload did not match the schema this library expects. */
export class T3DecodeError extends T3Error {
  readonly code = "decode" as const;
  /** Where the payload came from, for example `orchestration.subscribeThread` or `GET /api/orchestration/shell`. */
  readonly source: string;
  readonly issues: ZodError["issues"];
  /** The payload that failed to decode, with credential-shaped values redacted. */
  readonly raw: unknown;

  constructor(source: string, error: ZodError, raw: unknown) {
    super(`${source} returned a payload this client cannot decode: ${summarizeIssues(error)}`, {
      cause: error,
    });
    this.source = source;
    this.issues = error.issues;
    this.raw = redactSecrets(raw);
  }
}

function summarizeIssues(error: ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join(".") || "$"}: ${issue.message}`)
    .join("; ");
}

/** The caller asked for something this client can tell is wrong before talking to the server. */
export class T3PreconditionError extends T3Error {
  readonly code = "precondition" as const;
}

/** A call or stream was cancelled by the caller (abort signal or early return). */
export class T3InterruptedError extends T3Error {
  readonly code = "interrupted" as const;
}

export class T3TimeoutError extends T3Error {
  readonly code = "timeout" as const;
}

export function isT3Error(value: unknown): value is T3Error {
  return value instanceof T3Error;
}
