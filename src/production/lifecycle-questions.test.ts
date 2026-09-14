// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import type {
  AnsweredEscalation,
  PendingEscalation,
} from "../mcp-server/index.js";
import {
  questionAnswerOutput,
  renderQuestionText,
} from "./lifecycle-questions.js";

const projection = {
  blueprint: { metadata: { limit: 2 } },
  current: { node: "diagnose", visit: 1 },
  outputs: { diagnose: { severity: "high", summary: "Queue is stalled" } },
  task: { id: 17, title: "Sample" },
  visits: { diagnose: 1 },
};

describe("lifecycle question text", () => {
  it("renders the graph's data into the question", () => {
    expect(
      renderQuestionText(
        "Apply the proposal? Severity: {{ lifecycle.outputs.diagnose.severity }} for task {{ task.id }}",
        { lifecycle: projection, task: projection.task },
      ),
    ).toBe("Apply the proposal? Severity: high for task 17");
  });

  it("fails closed on data the graph does not have", () => {
    expect(() =>
      renderQuestionText("{{ lifecycle.outputs.review.findings }}", {
        lifecycle: projection,
        task: projection.task,
      }),
    ).toThrow(/failed to render/);
  });
});

describe("lifecycle question answer output", () => {
  const opened = {
    questions: [
      {
        id: "confirm",
        multiSelect: false,
        options: [{ label: "yes" }, { label: "no" }],
        question: "Apply?",
      },
      { id: "note", multiSelect: false, options: [], question: "Anything?" },
    ],
  } as unknown as PendingEscalation;

  it("carries the answers verbatim with a per-option projection and the answerer", () => {
    const answered = {
      answeredBy: { kind: "operator" },
      answers: {
        confirm: {
          reasoning: "Low blast radius",
          selectedOptions: ["yes"],
          text: "",
        },
        note: {
          reasoning: "Context",
          selectedOptions: [],
          text: "Watch the queue",
        },
      },
      escalationId: "question:confirm:1",
      ownerSessionKey: "question:confirm:1",
      prose: "Go ahead.",
    } as unknown as AnsweredEscalation;

    expect(questionAnswerOutput(opened, answered)).toEqual({
      answeredBy: { kind: "operator" },
      answers: answered.answers,
      prose: "Go ahead.",
      selected: { confirm: { yes: true }, note: {} },
    });
  });
});
