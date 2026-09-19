import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeT3Server } from "../../test/support/fake-server.js";
import { routeProviderSession } from "../../test/support/fake-routes.js";
import { T3AuthError, T3PreconditionError } from "../errors.js";
import { threadId } from "../schemas/common.js";
import { HttpTransport } from "../transport/http.js";
import { McpApi } from "./mcp.js";

const validInput = {
  threadId: threadId("record-1"),
  name: "sample-service",
  endpoint: "https://example.invalid/mcp",
  authorizationHeader: "Bearer credential-1",
};

describe("McpApi", () => {
  it("registers, ensures, and clears through the fork route", async () => {
    const methods: string[] = [];
    const api = makeApi(async (_input, init) => {
      methods.push(init?.method ?? "");
      return new Response(null, { status: 204 });
    });
    await api.register(validInput);
    await api.ensureRegistration(validInput);
    await api.clear({ threadId: validInput.threadId, name: validInput.name });
    expect(methods).toEqual(["PUT", "PUT", "DELETE"]);
  });

  it.each([
    [{ ...validInput, name: "Bad_Name" }, "name"],
    [{ ...validInput, name: "t3-code" }, "name"],
    [{ ...validInput, endpoint: "ftp://example.invalid/mcp" }, "endpoint"],
    [{ ...validInput, authorizationHeader: "Basic credential-1" }, "authorizationHeader"],
  ])("rejects invalid registration fields", async (input, field) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const api = makeApi(fetch);
    const promise = api.register(input);
    await expect(promise).rejects.toBeInstanceOf(T3PreconditionError);
    await expect(promise).rejects.toThrow(field);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("clears the registration when the callback fails", async () => {
    const methods: string[] = [];
    const api = makeApi(async (_input, init) => {
      methods.push(init?.method ?? "");
      return new Response(null, { status: 204 });
    });
    const failure = new T3PreconditionError("sample failure");
    await expect(
      api.withRegistration(validInput, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(methods).toEqual(["PUT", "DELETE"]);
  });
});

describe("McpApi native session read", () => {
  let server: FakeT3Server;
  const known = new Map<string, string>();

  beforeEach(async () => {
    known.clear();
    server = await FakeT3Server.start({ token: "credential-1" });
    routeProviderSession(server.routes, known);
  });

  afterEach(async () => {
    await server.close();
  });

  const api = (): McpApi =>
    new McpApi(
      new HttpTransport({ baseUrl: server.httpUrl, getAccessToken: async () => "credential-1" }),
    );

  it("keeps the native session identity exactly as the server reports it", async () => {
    const exact = "  session/A B\u00e9-1\t  ";
    known.set("record-1", exact);
    expect(await api().nativeSessionId({ threadId: threadId("record-1") })).toBe(exact);
    const request = server.routes.requests.at(-1);
    expect(request?.query.get("threadId")).toBe("record-1");
    expect(request?.headers["authorization"]).toBe("Bearer credential-1");
  });

  it("reads an unknown identity as not known", async () => {
    expect(await api().nativeSessionId({ threadId: threadId("record-2") })).toBeNull();
  });

  it.each([401, 403])("names the endpoint and the scope when refused", async (status) => {
    server.routes.route("GET /api/mcp/provider-session", () => ({
      status,
      body: { requiredScope: "orchestration:operate" },
    }));
    const failure = api().nativeSessionId({ threadId: threadId("record-1") });
    await expect(failure).rejects.toBeInstanceOf(T3AuthError);
    await expect(failure).rejects.toThrow("/api/mcp/provider-session");
    await expect(failure).rejects.toThrow("orchestration:operate");
  });

  it("rejects a malformed thread id before sending", async () => {
    const before = server.routes.requests.length;
    await expect(api().nativeSessionId({ threadId: "" as never })).rejects.toBeInstanceOf(
      T3PreconditionError,
    );
    expect(server.routes.requests.length).toBe(before);
  });
});

function makeApi(fetch: typeof globalThis.fetch): McpApi {
  return new McpApi(
    new HttpTransport({
      baseUrl: "https://example.invalid",
      fetch,
      getAccessToken: async () => "credential-1",
    }),
  );
}
