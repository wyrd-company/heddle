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
          answers: { selection: "first" },
          modelSlug: "sample-model",
          prose: "The selection is reversible within the epic.",
        },
        sequence: 1,
        type: "mcp:escalation-answered",
      }),
    ).toBe(
      'ADJUDICATION · sample-model · {"selection":"first"} · The selection is reversible within the epic.',
    );
  });
});
