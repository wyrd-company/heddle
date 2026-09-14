// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import { assertAdvanceOutput } from "./advance-output.js";

const findings = {
  name: "review-findings",
  schema: {
    properties: { findings: { minItems: 1, type: "array" } },
    required: ["findings"],
    type: "object",
  },
};

describe("advance output contract", () => {
  it("accepts omitted and arbitrary output when the disposition has no contract", () => {
    expect(() =>
      assertAdvanceOutput("approve", undefined, undefined),
    ).not.toThrow();
    expect(() =>
      assertAdvanceOutput("complete", undefined, { count: 3 }),
    ).not.toThrow();
  });

  it("validates output against the pinned schema and names the contract", () => {
    expect(() => assertAdvanceOutput("reject", findings, undefined)).toThrow(
      /reject.*review-findings.*output is missing/,
    );
    expect(() =>
      assertAdvanceOutput("reject", findings, { findings: [] }),
    ).toThrow(/reject.*review-findings.*findings/);
    expect(() =>
      assertAdvanceOutput("reject", findings, {
        findings: [{ code: "P1", summary: "A recorded value is unchecked" }],
      }),
    ).not.toThrow();
  });

  it("reports every schema violation, not only the first", () => {
    expect(() =>
      assertAdvanceOutput(
        "diagnosed",
        {
          name: "sample-diagnosis",
          schema: {
            properties: {
              state: { enum: ["live", "cleared"] },
              summary: { minLength: 1, type: "string" },
            },
            required: ["state", "summary"],
            type: "object",
          },
        },
        { state: "unknown", summary: "" },
      ),
    ).toThrow(/state.*allowed values.*summary.*fewer than 1/s);
  });
});
