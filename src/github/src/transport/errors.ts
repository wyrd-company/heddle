export type ErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "UNAUTHENTICATED"
  | "RATE_LIMITED"
  | "VALIDATION"
  | "SCHEMA_MISMATCH"
  | "RESPONSE_SHAPE"
  | "NOT_DRAFT"
  | "AMBIGUOUS"
  | "UNSUPPORTED"
  | "UNKNOWN";

export interface GitHubErrorOptions {
  requestId?: string;
  cause?: unknown;
}

export class GitHubError extends Error {
  readonly code: ErrorCode;
  readonly requestId: string | undefined;

  constructor(code: ErrorCode, message: string, options: GitHubErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GitHubError";
    this.code = code;
    this.requestId = options.requestId;
  }
}

export class NotFoundError extends GitHubError {
  readonly resource: string;
  readonly key: string;

  constructor(resource: string, key: string, options?: GitHubErrorOptions) {
    super("NOT_FOUND", `${resource} not found: ${key}`, options);
    this.name = "NotFoundError";
    this.resource = resource;
    this.key = key;
  }
}

export class AmbiguousError extends GitHubError {
  readonly resource: string;
  readonly key: string;
  readonly candidates: number[];

  constructor(resource: string, key: string, candidates: number[], options?: GitHubErrorOptions) {
    super(
      "AMBIGUOUS",
      `${resource} "${key}" matches ${candidates.length}: ${candidates.join(", ")}`,
      options,
    );
    this.name = "AmbiguousError";
    this.resource = resource;
    this.key = key;
    this.candidates = candidates;
  }
}

export class ValidationError extends GitHubError {
  constructor(message: string, options?: GitHubErrorOptions) {
    super("VALIDATION", message, options);
    this.name = "ValidationError";
  }
}

export class RateLimitError extends GitHubError {
  readonly resetAt: Date;
  readonly remaining: number;

  constructor(resetAt: Date, remaining: number, options?: GitHubErrorOptions) {
    super("RATE_LIMITED", `rate limited until ${resetAt.toISOString()}`, options);
    this.name = "RateLimitError";
    this.resetAt = resetAt;
    this.remaining = remaining;
  }
}

export interface SchemaGap {
  kind: "missing-field" | "type-mismatch" | "missing-option" | "unknown-field";
  field: string;
  detail?: string;
}

export class SchemaMismatchError extends GitHubError {
  readonly gaps: SchemaGap[];

  constructor(gaps: SchemaGap[], options?: GitHubErrorOptions) {
    super(
      "SCHEMA_MISMATCH",
      `schema mismatch: ${gaps.map((g) => `${g.kind} ${g.field}`).join(", ")}`,
      options,
    );
    this.name = "SchemaMismatchError";
    this.gaps = gaps;
  }
}

export class ResponseShapeError extends GitHubError {
  readonly path: string;

  constructor(path: string, detail: string, options?: GitHubErrorOptions) {
    super("RESPONSE_SHAPE", `unexpected response at ${path}: ${detail}`, options);
    this.name = "ResponseShapeError";
    this.path = path;
  }
}

export function notImplemented(name: string): never {
  throw new GitHubError("UNSUPPORTED", `not implemented: ${name}`);
}

/** GraphQL error `type` values GitHub emits, mapped to codes. */
const graphqlTypeCodes: Record<string, ErrorCode> = {
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  UNAUTHORIZED: "UNAUTHENTICATED",
  RATE_LIMITED: "RATE_LIMITED",
  UNPROCESSABLE: "VALIDATION",
  INSUFFICIENT_SCOPES: "FORBIDDEN",
};

export interface GraphqlErrorEntry {
  type?: string;
  message: string;
  path?: readonly (string | number)[];
  extensions?: { code?: string; [key: string]: unknown };
}

export function codeForGraphqlErrors(errors: readonly GraphqlErrorEntry[]): ErrorCode {
  for (const error of errors) {
    const type = error.type ?? error.extensions?.code;
    if (type && graphqlTypeCodes[type]) return graphqlTypeCodes[type];
  }
  return errors.length > 0 ? "VALIDATION" : "UNKNOWN";
}

export function codeForRestStatus(status: number): ErrorCode {
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 422) return "VALIDATION";
  if (status === 429) return "RATE_LIMITED";
  return "UNKNOWN";
}

/** Rate limit facts from response headers, when the response says the limit is spent. */
export function rateLimitFromHeaders(
  status: number,
  headers: Record<string, string | undefined>,
): { resetAt: Date; remaining: number } | undefined {
  const remaining = Number(headers["x-ratelimit-remaining"]);
  const reset = Number(headers["x-ratelimit-reset"]);
  const retryAfter = Number(headers["retry-after"]);
  if (status === 429 || ((status === 403 || status === 200) && remaining === 0)) {
    const resetAt = Number.isFinite(reset)
      ? new Date(reset * 1000)
      : new Date(Date.now() + (Number.isFinite(retryAfter) ? retryAfter : 60) * 1000);
    return { resetAt, remaining: Number.isFinite(remaining) ? remaining : 0 };
  }
  return undefined;
}
