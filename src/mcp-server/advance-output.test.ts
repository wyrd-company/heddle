// ---
// relationships:
//   verifies: heddle
// ---

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { assertAdvanceOutput } from "./advance-output.js";

describe("advance output contract", () => {
  it("ships the runtime schema with the public contract identity", async () => {
    const artifact = JSON.parse(
      await readFile("schemas/advance-output.json", "utf8"),
    ) as { $id?: string };

    expect(artifact.$id).toBe(
      "https://wyrd.company/heddle/advance-output.schema.json",
    );
  });

  it("permits omitted and arbitrary JSON output for optional dispositions", () => {
    expect(() =>
      assertAdvanceOutput("approve", "optional", undefined),
    ).not.toThrow();
    expect(() =>
      assertAdvanceOutput("complete", "optional", { count: 3 }),
    ).not.toThrow();
  });

  it("requires a non-empty findings array for review rejection dispositions", () => {
    expect(() =>
      assertAdvanceOutput("reject", "review-findings", undefined),
    ).toThrow(/reject.*review-findings.*output/);
    expect(() =>
      assertAdvanceOutput("reject", "review-findings", { findings: [] }),
    ).toThrow(/reject.*review-findings.*findings/);
    expect(() =>
      assertAdvanceOutput("reject", "review-findings", {
        findings: [{ code: "P1", summary: "A recorded value is unchecked" }],
      }),
    ).not.toThrow();
  });
});
