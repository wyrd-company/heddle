// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import { errorDetail } from "../error-details.js";
import {
  productionErrorAttention,
  productionErrorCodeDeclarations,
  productionErrorIncidentEligible,
  productionErrorIncidentId,
  schedulerPassFailureAttention,
  type ProductionErrorCode,
} from "./error-visibility.js";

describe("production error visibility", () => {
  it("declares incident eligibility for every production error code", () => {
    expect(productionErrorCodeDeclarations).toEqual({
      "board-task-absent": { incidentEligible: true },
      "child-promotion-failed": { incidentEligible: true },
      "dynamic-task-authority-ambiguous": { incidentEligible: true },
      "dynamic-task-authority-conflicting": { incidentEligible: true },
      "dynamic-task-authority-failed": { incidentEligible: false },
      "dynamic-task-authority-malformed": { incidentEligible: true },
      "epic-project-reconciliation-failed": { incidentEligible: true },
      "epic-status-transition-failed": { incidentEligible: true },
      "instance-synchronization-failed": { incidentEligible: true },
      "lifecycle-attention-bridge-failed": { incidentEligible: true },
      "lifecycle-execution-failed": { incidentEligible: true },
      "lifecycle-instance-absent": { incidentEligible: true },
      "notification-delivery-recovery-required": { incidentEligible: true },
      "notification-delivery-rejected": { incidentEligible: true },
      "notification-delivery-retryable": { incidentEligible: true },
      "scheduler-pass-failed": { incidentEligible: false },
      "session-observation-failed": { incidentEligible: true },
      "session-page-delivery-failed": { incidentEligible: true },
      "stale-attention-failed": { incidentEligible: true },
      "task-reconciliation-failed": { incidentEligible: true },
      "task-status-mirror-failed": { incidentEligible: true },
    });
    expect(() =>
      productionErrorIncidentEligible(
        "unclassified-production-error" as ProductionErrorCode,
      ),
    ).toThrow("has no incident eligibility");
  });

  it("derives one deterministic incident identity from an eligible attention identity", () => {
    const attentionId = "production:task-reconciliation-failed:task:17";
    const first = productionErrorIncidentId(attentionId);
    expect(productionErrorIncidentId(attentionId)).toBe(first);
    expect(productionErrorIncidentId(`${attentionId}:other`)).not.toBe(first);
    expect(
      productionErrorAttention({
        code: "task-reconciliation-failed",
        error: new Error("Synthetic failure"),
        summary: "Task reconciliation failed",
        taskId: 17,
      }),
    ).toMatchObject({
      incidentId: expect.stringMatching(/^incident:[a-f0-9]{64}$/),
    });
  });

  it.each([
    ["scheduler-pass-failed", "scheduler"],
    ["dynamic-task-authority-failed", "persistence"],
  ] as const)(
    "states the operator-only floor for %s (%s failure class)",
    (code) => {
      const attention = productionErrorAttention({
        code,
        error: new Error("Synthetic failure"),
        summary: "Production operation failed",
        varyByError: true,
      });
      expect(attention.incidentId).toBeNull();
      expect(attention.message).toContain(
        "An incident cannot be raised for this error. Operator action is required.",
      );
    },
  );

  it("derives scheduler attention identity from its positive episode", () => {
    expect(
      schedulerPassFailureAttention({
        episode: 7,
        error: errorDetail(new Error("Synthetic failure")),
      }),
    ).toMatchObject({
      attentionId: "production:scheduler-pass-failed:global:episode:7",
      code: "scheduler-pass-failed",
      incidentId: null,
    });
    for (const episode of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        schedulerPassFailureAttention({
          episode,
          error: errorDetail(new Error("Synthetic failure")),
        }),
      ).toThrow("Scheduler pass episode must be a positive safe integer");
    }
  });
});
