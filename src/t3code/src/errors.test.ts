import { describe, expect, it } from "vitest";
import { z } from "zod";
import { T3AuthError, T3DecodeError, T3HttpError } from "./errors.js";

describe("error payload redaction", () => {
  it("T3DecodeError.raw does not carry credentials from a badly shaped token response", () => {
    const raw = { access_token: "secret-1", scope: "orchestration:read", expires_in: "soon" };
    const result = z.looseObject({ expires_in: z.number() }).safeParse(raw);
    if (result.success) throw new Error("expected a decode failure");
    const error = new T3DecodeError("POST /oauth/token", result.error, raw);
    expect(error.raw).toEqual({
      access_token: "[redacted]",
      scope: "orchestration:read",
      expires_in: "soon",
    });
    expect(raw.access_token).toBe("secret-1");
    expect(error.message).not.toContain("secret-1");
  });

  it("T3HttpError.body and its subclasses redact credential-shaped fields", () => {
    const details = {
      status: 400,
      method: "POST",
      path: "/oauth/token",
      body: { error: "invalid_grant", subject_token: "pairing-1", nested: { ticket: "t-1" } },
    };
    expect(new T3HttpError("failed", details).body).toEqual({
      error: "invalid_grant",
      subject_token: "[redacted]",
      nested: { ticket: "[redacted]" },
    });
    expect(new T3AuthError("failed", { ...details, code: "auth_invalid" }).body).toMatchObject({
      subject_token: "[redacted]",
    });
    expect(new T3HttpError("failed", { ...details, body: "plain text" }).body).toBe("plain text");
  });
});
