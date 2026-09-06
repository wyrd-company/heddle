// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import {
  isWorkflowMcpStageContract,
  removedHandoffTemplateBlobHashDiagnostic,
} from "./stage-contract.js";

const contract = () => ({
  blueprintBlobHash: "a".repeat(40),
  blueprintPath: "blueprints/sample-process.json",
  dispositions: [{ description: "Complete the sample", name: "complete" }],
  handoffTemplate: {
    commitSha: "b".repeat(40),
    path: "handoff-templates/standard.md",
  },
  skills: ["evidence-review"],
  stage: "inspect",
  todoTemplate: "sample-checklist",
  tools: ["advance"],
});

describe("workflow MCP stage contract", () => {
  it.each([40, 64])("accepts a %i-character handoff commit SHA", (length) => {
    const value = contract();
    value.handoffTemplate.commitSha = "b".repeat(length);

    expect(isWorkflowMcpStageContract(value)).toBe(true);
  });

  it.each([39, 41, 63, 65])(
    "rejects a %i-character handoff commit SHA",
    (length) => {
      const value = contract();
      value.handoffTemplate.commitSha = "b".repeat(length);

      expect(isWorkflowMcpStageContract(value)).toBe(false);
    },
  );

  it("rejects an uppercase handoff commit SHA", () => {
    const value = contract();
    value.handoffTemplate.commitSha = "B".repeat(40);

    expect(isWorkflowMcpStageContract(value)).toBe(false);
  });

  it.each([
    { label: "non-string", skills: [17] },
    { label: "non-kebab", skills: ["EvidenceReview"] },
    { label: "duplicate", skills: ["evidence-review", "evidence-review"] },
  ])("rejects $label stage skills", ({ skills }) => {
    const value = contract();
    value.skills = skills as unknown as string[];

    expect(isWorkflowMcpStageContract(value)).toBe(false);
  });

  it("rejects the removed handoff blobHash shape with a named diagnostic", () => {
    const value = contract() as Record<string, unknown>;
    value["handoffTemplate"] = {
      blobHash: "b".repeat(40),
      path: "handoff-templates/standard.md",
    };

    expect(isWorkflowMcpStageContract(value)).toBe(false);
    expect(removedHandoffTemplateBlobHashDiagnostic(value)).toBe(
      "Workflow MCP stage contract uses removed handoff template field 'blobHash'; use 'commitSha'",
    );
  });
});
