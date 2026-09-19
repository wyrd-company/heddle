import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  T3AuthError,
  T3ConnectionError,
  T3DecodeError,
  T3HttpError,
  T3NotFoundError,
} from "../errors.js";
import { HttpTransport } from "./http.js";

const Result = z.looseObject({ value: z.string() });

describe("HttpTransport", () => {
  it("sends query, JSON, user agent, and bearer auth and decodes success", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://example.invalid/records?limit=2");
      expect(request.headers.get("authorization")).toBe("Bearer credential-1");
      expect(request.headers.get("content-type")).toBe("application/json");
      expect(request.headers.get("user-agent")).toBe("client/1");
      expect(await request.json()).toEqual({ label: "sample" });
      return Response.json({ value: "ok", addedLater: true });
    });
    const transport = makeTransport(fetch, "credential-1");

    await expect(
      transport.request({
        method: "POST",
        path: "/records",
        query: { limit: 2, cursor: undefined },
        body: { label: "sample" },
        auth: "required",
        decode: Result,
      }),
    ).resolves.toMatchObject({ value: "ok" });
  });

  it("sends form bodies and accepts empty responses", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("content-type")).toBe(
        "application/x-www-form-urlencoded",
      );
      return new Response(null, { status: 204 });
    });
    await expect(
      makeTransport(fetch).request({
        method: "POST",
        path: "/exchange",
        body: new URLSearchParams({ item: "value" }),
        decode: "empty",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects required auth locally when no token exists", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      makeTransport(fetch).request({
        method: "GET",
        path: "/private",
        auth: "required",
        decode: Result,
      }),
    ).rejects.toMatchObject({ code: "auth_invalid", reason: "missing_credential" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      401,
      { _tag: "EnvironmentAuthInvalidError", reason: "invalid_credential", traceId: "trace-1" },
      T3AuthError,
      { code: "auth_invalid", tag: "EnvironmentAuthInvalidError", traceId: "trace-1" },
    ],
    [
      403,
      { error: "insufficient_scope", requiredScope: "access:read" },
      T3AuthError,
      { code: "insufficient_scope", reason: "insufficient_scope", requiredScope: "access:read" },
    ],
    [
      404,
      { _tag: "EnvironmentResourceNotFoundError", reason: "record_not_found" },
      T3NotFoundError,
      { code: "not_found", reason: "record_not_found" },
    ],
    [
      400,
      { _tag: "EnvironmentRequestInvalidError", reason: "invalid_request", traceId: "trace-2" },
      T3HttpError,
      { code: "http", reason: "invalid_request", traceId: "trace-2" },
    ],
    [500, "not json", T3HttpError, { code: "http", body: "not json" }],
  ])("maps HTTP %i responses", async (status, body, errorType, fields) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      typeof body === "string" ? new Response(body, { status }) : Response.json(body, { status }),
    );
    const promise = makeTransport(fetch, "credential-1").request({
      method: "GET",
      path: "/records",
      auth: "required",
      decode: Result,
    });
    await expect(promise).rejects.toBeInstanceOf(errorType);
    await expect(promise).rejects.toMatchObject(fields);
  });

  it("maps fetch rejection and response schema mismatch", async () => {
    const failedFetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error("offline");
    });
    await expect(
      makeTransport(failedFetch).request({ method: "GET", path: "/records", decode: Result }),
    ).rejects.toBeInstanceOf(T3ConnectionError);

    const invalidFetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ value: 3 }));
    await expect(
      makeTransport(invalidFetch).request({ method: "GET", path: "/records", decode: Result }),
    ).rejects.toBeInstanceOf(T3DecodeError);
  });
});

function makeTransport(fetch: typeof globalThis.fetch, token?: string): HttpTransport {
  return new HttpTransport({
    baseUrl: "https://example.invalid",
    fetch,
    getAccessToken: async () => token,
    userAgent: "client/1",
  });
}
