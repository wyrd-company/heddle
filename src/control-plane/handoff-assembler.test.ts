// ---
// relationships:
//   verifies: heddle
// ---

import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { assembleStageHandoff } from "./handoff-assembler.js";

describe("assembleStageHandoff", () => {
  it("is byte-identical for the same instance data", () => {
    const first = assembleStageHandoff({
      correlationToken: "correlation-token",
      stage: {
        kind: "standard",
        name: "prepare",
        priorStageOutputs: [{ result: "ready", count: 2 }],
      },
      skillPointer: "skill://prepare",
      taskContract: { title: "Prepare inventory", priority: "normal" },
      todoList: [
        { text: "Count items", complete: false },
        { complete: true, text: "Open container" },
      ],
    });
    const second = assembleStageHandoff({
      taskContract: { priority: "normal", title: "Prepare inventory" },
      todoList: [
        { complete: false, text: "Count items" },
        { text: "Open container", complete: true },
      ],
      skillPointer: "skill://prepare",
      stage: {
        priorStageOutputs: [{ count: 2, result: "ready" }],
        name: "prepare",
        kind: "standard",
      },
      correlationToken: "correlation-token",
    });

    expect(Buffer.from(first)).toEqual(Buffer.from(second));
  });

  it("carries remediation findings without carrying the review transcript", () => {
    const handoff = assembleStageHandoff({
      correlationToken: "correlation-token",
      stage: {
        cause: { kind: "review-findings" },
        kind: "remediation",
        name: "repair",
        review: {
          findings: [{ code: "P1", summary: "The total is not checked" }],
          transcript: ["private review discussion"],
        },
      },
      skillPointer: "skill://repair",
      taskContract: { title: "Prepare inventory" },
      todoList: [{ complete: false, text: "Check total" }],
    });

    expect(JSON.parse(handoff)).toMatchObject({
      stage: {
        kind: "remediation",
        remediationCause: { kind: "review-findings" },
        name: "repair",
        reviewFindings: [{ code: "P1", summary: "The total is not checked" }],
      },
    });
    expect(handoff).not.toContain("private review discussion");
    expect(handoff).not.toContain("transcript");
    expect(handoff).not.toContain("correlation-token");
  });

  it("carries an exact review-basis drift cause", () => {
    const cause = {
      currentSourceHead: "c".repeat(40),
      currentTargetHead: "d".repeat(40),
      kind: "review-basis-drift" as const,
      reviewedBaseHead: "b".repeat(40),
      reviewedSourceHead: "a".repeat(40),
      snapshotId: "SAMPLE1",
      sourceBranch: "task/change",
      targetBranch: "main",
    };
    const handoff = assembleStageHandoff({
      correlationToken: "correlation-token",
      skillPointer: "skill://repair",
      stage: {
        cause,
        kind: "remediation",
        name: "repair",
        review: { findings: [] },
      },
      taskContract: { title: "Prepare inventory" },
      todoList: [{ complete: false, text: "Check total" }],
    });

    expect(JSON.parse(handoff)).toMatchObject({
      stage: { remediationCause: cause, reviewFindings: [] },
    });
  });
});
