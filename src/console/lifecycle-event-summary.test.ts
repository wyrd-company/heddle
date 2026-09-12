// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import { lifecycleEventSummary } from "./lifecycle-event-summary.js";

describe("lifecycle event summary", () => {
  it("shows an adjudicated decision, model, and reasoning", () => {
    expect(
      lifecycleEventSummary({
        executionId: "execution-one",
        payload: {
          answeredBy: { kind: "adjudication", sessionKey: "session-one" },
          answers: {
            selection: {
              selectedOptions: ["First"],
              text: "",
              reasoning: "Fits the sample.",
            },
          },
          modelSlug: "sample-model",
        },
        sequence: 1,
        type: "mcp:escalation-answered",
      }),
    ).toBe(
      'ADJUDICATION · sample-model · {"selection":{"selectedOptions":["First"],"text":"","reasoning":"Fits the sample."}}',
    );
  });
});
