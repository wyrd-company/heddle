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
        name: "prepare",
        priorStageOutputs: [{ result: "ready", count: 2 }],
        skills: ["evidence-review"],
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
        skills: ["evidence-review"],
      },
      correlationToken: "correlation-token",
    });

    expect(Buffer.from(first)).toEqual(Buffer.from(second));
    expect(JSON.parse(first)).toMatchObject({
      stage: { entry: null, skills: ["evidence-review"] },
    });
  });

  it("carries the entry node and its output", () => {
    const handoff = assembleStageHandoff({
      correlationToken: "correlation-token",
      stage: {
        entry: {
          node: "inspect",
          output: {
            disposition: "reject",
            findings: [{ code: "P1", summary: "The total is not checked" }],
          },
        },
        name: "repair",
        priorStageOutputs: [{ result: "ready" }],
      },
      skillPointer: "skill://repair",
      taskContract: { title: "Prepare inventory" },
      todoList: [{ complete: false, text: "Check total" }],
    });

    expect(JSON.parse(handoff)).toMatchObject({
      stage: {
        entry: {
          node: "inspect",
          output: {
            disposition: "reject",
            findings: [{ code: "P1", summary: "The total is not checked" }],
          },
        },
        name: "repair",
        priorStageOutputs: [{ result: "ready" }],
        skills: [],
      },
    });
    expect(handoff).not.toContain("correlation-token");
  });
});
