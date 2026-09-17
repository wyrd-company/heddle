import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact.js";

describe("redactSecrets", () => {
  it("replaces string values under credential-like keys, at any depth", () => {
    const input = {
      access_token: "abc",
      refreshToken: "def",
      credential: "ghi",
      clientSecret: "jkl",
      Authorization: "Bearer mno",
      password: "pqr",
      wsTicket: "stu",
      label: "kept",
      nested: { list: [{ token: "vwx", count: 1 }, "plain"] },
    };
    expect(redactSecrets(input)).toEqual({
      access_token: "[redacted]",
      refreshToken: "[redacted]",
      credential: "[redacted]",
      clientSecret: "[redacted]",
      Authorization: "[redacted]",
      password: "[redacted]",
      wsTicket: "[redacted]",
      label: "kept",
      nested: { list: [{ token: "[redacted]", count: 1 }, "plain"] },
    });
  });

  it("copies instead of mutating and leaves non-string secrets and non-plain values alone", () => {
    const input = { token: 42, tokens: ["a"], when: new Date(0) };
    const out = redactSecrets(input) as typeof input;
    expect(out).not.toBe(input);
    expect(out.token).toBe(42);
    expect(out.tokens).toEqual(["a"]);
    expect(out.when).toBe(input.when);
    expect(redactSecrets("token")).toBe("token");
    expect(redactSecrets(null)).toBeNull();
  });

  it("survives a cycle", () => {
    const input: Record<string, unknown> = { token: "x" };
    input["self"] = input;
    expect(redactSecrets(input)).toEqual({ token: "[redacted]", self: undefined });
  });
});
