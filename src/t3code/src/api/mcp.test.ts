import { describe, expect, it, vi } from "vitest";

import { T3PreconditionError } from "../errors.js";
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

function makeApi(fetch: typeof globalThis.fetch): McpApi {
  return new McpApi(
    new HttpTransport({
      baseUrl: "https://example.invalid",
      fetch,
      getAccessToken: async () => "credential-1",
    }),
  );
}
