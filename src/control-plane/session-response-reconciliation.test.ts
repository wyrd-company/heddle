// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import type { T3ThreadSnapshot } from "./t3-control-plane-client.js";
import {
  approvalResponseRecorded,
  userInputResponseRecorded,
} from "./session-response-reconciliation.js";

const snapshot = (
  kind: "approval.resolved" | "user-input.resolved",
  payload: Record<string, unknown>,
): T3ThreadSnapshot => ({
  thread: { activities: [{ kind, payload }] },
});

describe("T3 response reconciliation", () => {
  it("accepts only the recorded approval decision for the intended request", () => {
    const recorded = snapshot("approval.resolved", {
      decision: "accept",
      requestId: "request-one",
    });
    expect(approvalResponseRecorded(recorded, "request-one", "accept")).toBe(
      true,
    );
    expect(() =>
      approvalResponseRecorded(recorded, "request-one", "reject"),
    ).toThrow("resolved with a different decision");
    expect(approvalResponseRecorded(recorded, "request-other", "accept")).toBe(
      false,
    );
  });

  it("accepts only the recorded user-input answers for the intended request", () => {
    const recorded = snapshot("user-input.resolved", {
      answers: { quantity: "Small", routes: ["First", "Second"] },
      requestId: "request-one",
    });
    expect(
      userInputResponseRecorded(recorded, "request-one", {
        routes: ["First", "Second"],
        quantity: "Small",
      }),
    ).toBe(true);
    expect(() =>
      userInputResponseRecorded(recorded, "request-one", {
        quantity: "Large",
        routes: ["First", "Second"],
      }),
    ).toThrow("resolved with different answers");
    expect(
      userInputResponseRecorded(recorded, "request-other", {
        quantity: "Small",
      }),
    ).toBe(false);
  });
});
