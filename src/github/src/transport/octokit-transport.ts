import type { Octokit } from "@octokit/core";
import { createOctokit, type Auth, type OctokitFactoryOptions } from "../auth.js";
import {
  codeForGraphqlErrors,
  codeForRestStatus,
  GitHubError,
  rateLimitFromHeaders,
  RateLimitError,
  type GraphqlErrorEntry,
} from "./errors.js";
import type { GraphqlOperation, RestResponse, Transport } from "./transport.js";

/** Production adapter. Owns Octokit construction and error normalisation. */
export class OctokitTransport implements Transport {
  readonly #octokit: Promise<Octokit>;

  constructor(auth: Auth, options: OctokitFactoryOptions = {}) {
    this.#octokit = createOctokit(auth, options);
    // Construction failures surface on the first call, not as an unhandled rejection.
    this.#octokit.catch(() => undefined);
  }

  async graphql(op: GraphqlOperation): Promise<unknown> {
    const octokit = await this.#octokit;
    try {
      return await octokit.graphql(op.document, op.variables);
    } catch (error) {
      throw normalise(error, op.name);
    }
  }

  async rest(route: string, params: Record<string, unknown> = {}): Promise<RestResponse> {
    const octokit = await this.#octokit;
    try {
      const response = await octokit.request(route, params);
      return {
        status: response.status,
        data: response.data,
        headers: stringHeaders(response.headers),
      };
    } catch (error) {
      throw normalise(error, route);
    }
  }
}

interface GraphqlLikeError {
  name: string;
  errors?: GraphqlErrorEntry[];
  headers?: Record<string, string | undefined>;
  message: string;
}

interface RequestLikeError {
  name: string;
  status: number;
  message: string;
  response?: { headers?: Record<string, string | undefined> };
}

/** Maps Octokit's GraphqlResponseError and RequestError to the package hierarchy. */
export function normalise(error: unknown, context: string): GitHubError {
  if (error instanceof GitHubError) return error;
  if (isGraphqlError(error)) {
    const headers = error.headers ?? {};
    const requestId = headers["x-github-request-id"];
    const opts = requestId === undefined ? { cause: error } : { cause: error, requestId };
    const errors = error.errors ?? [];
    const code = codeForGraphqlErrors(errors);
    const messages = errors.map((e) => e.message).join("; ");
    if (code === "RATE_LIMITED") {
      const limit = rateLimitFromHeaders(200, headers) ?? { resetAt: new Date(), remaining: 0 };
      return new RateLimitError(limit.resetAt, limit.remaining, opts);
    }
    return new GitHubError(code, `${context}: ${messages || error.message}`, opts);
  }
  if (isRequestError(error)) {
    const headers = error.response?.headers ?? {};
    const requestId = headers["x-github-request-id"];
    const opts = requestId === undefined ? { cause: error } : { cause: error, requestId };
    const limit = rateLimitFromHeaders(error.status, headers);
    if (limit) return new RateLimitError(limit.resetAt, limit.remaining, opts);
    return new GitHubError(codeForRestStatus(error.status), `${context}: ${error.message}`, opts);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new GitHubError("UNKNOWN", `${context}: ${message}`, { cause: error });
}

function isGraphqlError(error: unknown): error is GraphqlLikeError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: string }).name === "GraphqlResponseError"
  );
}

function isRequestError(error: unknown): error is RequestLikeError {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { status?: unknown }).status === "number" &&
    (error as { name?: string }).name === "HttpError"
  );
}

function stringHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key] = value;
    else if (typeof value === "number") out[key] = String(value);
  }
  return out;
}
