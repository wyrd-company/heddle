// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import { assertConsoleTokenAbsent } from "./token-disclosure.js";

const token = "opaque-fixture-credential";

describe("console token disclosure guard", () => {
  it("rejects a token nested in a value", () => {
    expect(() =>
      assertConsoleTokenAbsent(
        { outer: [{ message: `fixture ${token} suffix` }] },
        [token],
      ),
    ).toThrow(
      "Console data is unavailable because it contains protected session data",
    );
  });

  it("rejects a token embedded in an object key", () => {
    expect(() =>
      assertConsoleTokenAbsent({ [`field-${token}`]: "safe" }, [token]),
    ).toThrow(
      "Console data is unavailable because it contains protected session data",
    );
  });

  it.each(["", " ", `${token} suffix`])(
    "rejects the malformed token catalog entry %j",
    (candidate) => {
      expect(() =>
        assertConsoleTokenAbsent({ value: "safe" }, [candidate]),
      ).toThrow(
        "Console data is unavailable because it contains protected session data",
      );
    },
  );

  it("preserves a structurally safe value", () => {
    const value = { outer: ["safe", { count: 41 }] };
    expect(() => assertConsoleTokenAbsent(value, [token])).not.toThrow();
    expect(value).toEqual({ outer: ["safe", { count: 41 }] });
  });
});
