import { describe, expect, it } from "vitest";
import { codeForGraphqlErrors, codeForRestStatus, rateLimitFromHeaders } from "./errors.js";
import { normalise } from "./octokit-transport.js";

describe("error mapping", () => {
  it("maps GraphQL error types to codes", () => {
    expect(codeForGraphqlErrors([{ type: "NOT_FOUND", message: "x" }])).toBe("NOT_FOUND");
    expect(codeForGraphqlErrors([{ message: "x", extensions: { code: "FORBIDDEN" } }])).toBe(
      "FORBIDDEN",
    );
    expect(codeForGraphqlErrors([{ message: "bad input" }])).toBe("VALIDATION");
    expect(codeForGraphqlErrors([])).toBe("UNKNOWN");
  });

  it("maps REST statuses to codes", () => {
    expect(codeForRestStatus(404)).toBe("NOT_FOUND");
    expect(codeForRestStatus(401)).toBe("UNAUTHENTICATED");
    expect(codeForRestStatus(422)).toBe("VALIDATION");
    expect(codeForRestStatus(500)).toBe("UNKNOWN");
  });

  it("detects a spent rate limit from headers", () => {
    const limit = rateLimitFromHeaders(403, {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "1700000000",
    });
    expect(limit?.resetAt.toISOString()).toBe("2023-11-14T22:13:20.000Z");
    expect(rateLimitFromHeaders(403, { "x-ratelimit-remaining": "12" })).toBeUndefined();
  });

  it("normalises Octokit GraphQL and request errors", () => {
    const graphql = Object.assign(new Error("boom"), {
      name: "GraphqlResponseError",
      errors: [{ type: "NOT_FOUND", message: "Could not resolve" }],
      headers: { "x-github-request-id": "req-1" },
    });
    const mapped = normalise(graphql, "OwnerLoad");
    expect(mapped.code).toBe("NOT_FOUND");
    expect(mapped.requestId).toBe("req-1");
    expect(mapped.message).toContain("OwnerLoad");

    const rest = Object.assign(new Error("Not Found"), { name: "HttpError", status: 404 });
    expect(normalise(rest, "GET /x").code).toBe("NOT_FOUND");

    const limited = Object.assign(new Error("limit"), {
      name: "HttpError",
      status: 429,
      response: { headers: { "x-ratelimit-reset": "1700000000" } },
    });
    expect(normalise(limited, "GET /x").code).toBe("RATE_LIMITED");
    expect(normalise("string failure", "op").code).toBe("UNKNOWN");
  });
});
