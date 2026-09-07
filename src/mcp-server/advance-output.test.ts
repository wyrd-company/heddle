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

  it("requires the incident condition state and known proposed action kinds", () => {
    expect(() =>
      assertAdvanceOutput("diagnosed", "incident-diagnosis", {
        proposedActions: [],
        rootCauseAnalysis: "A sample dependency was unavailable.",
      }),
    ).toThrow(/diagnosed.*incident-diagnosis.*conditionState/);
    expect(() =>
      assertAdvanceOutput("diagnosed", "incident-diagnosis", {
        conditionState: "live",
        proposedActions: [{ kind: "unknown-action", summary: "Do a thing" }],
        rootCauseAnalysis: "A sample dependency was unavailable.",
      }),
    ).toThrow(/unknown incident action kind "unknown-action"/);
    expect(() =>
      assertAdvanceOutput("diagnosed", "incident-diagnosis", {
        conditionState: "cleared",
        proposedActions: [
          { kind: "github-issue", summary: "Record the diagnosis" },
          { kind: "operator-escalation", summary: "Ask for a decision" },
          { kind: "production-mutation", summary: "Repair the dependency" },
        ],
        rootCauseAnalysis: "The condition ended after rechecking it.",
      }),
    ).not.toThrow();
  });
});
