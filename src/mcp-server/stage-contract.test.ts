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
    { label: "long", skills: ["a".repeat(65)] },
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

describe("stage contract output contracts", () => {
  const contract = () => ({
    blueprintBlobHash: "a".repeat(40),
    blueprintPath: "blueprints/sample.json",
    dispositions: [
      {
        description: "Return with findings",
        name: "reject",
        outputContract: "review-findings",
        outputSchema: { required: ["findings"], type: "object" },
      },
      { description: "Approve", name: "approve" },
    ],
    handoffTemplate: {
      commitSha: "b".repeat(40),
      path: "handoff-templates/sample.md",
    },
    skills: [],
    stage: "review",
    todoTemplate: "sample-review",
    tools: ["advance"],
  });

  it("accepts a disposition carrying its pinned contract name and schema", () => {
    expect(isWorkflowMcpStageContract(contract())).toBe(true);
  });

  it("rejects a contract name without its schema, or a schema without its name", () => {
    const nameOnly = contract();
    delete (nameOnly.dispositions[0] as Record<string, unknown>)[
      "outputSchema"
    ];
    expect(isWorkflowMcpStageContract(nameOnly)).toBe(false);
    const schemaOnly = contract();
    delete (schemaOnly.dispositions[0] as Record<string, unknown>)[
      "outputContract"
    ];
    expect(isWorkflowMcpStageContract(schemaOnly)).toBe(false);
  });

  it("rejects a contract name that is not a kebab-case artifact id", () => {
    const invalid = contract();
    invalid.dispositions[0]!.outputContract = "Review Findings";
    expect(isWorkflowMcpStageContract(invalid)).toBe(false);
  });
});
