// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import { errorDetail } from "../error-details.js";
import {
  productionErrorAttention,
  operatorOnlyProductionErrorCodes,
  productionErrorIncidentEligible,
  productionErrorIncidentId,
  schedulerPassFailureAttention,
  type ProductionErrorCode,
} from "./error-visibility.js";

describe("production error visibility", () => {
  it("admits an unclassified production error unless it is on the operator-only floor", () => {
    expect(operatorOnlyProductionErrorCodes).toEqual(
      new Set([
        "dynamic-task-authority-failed",
        "incident-execution-failed",
        "scheduler-pass-failed",
      ]),
    );
    expect(
      productionErrorIncidentEligible("unclassified-production-error"),
    ).toBe(true);
    expect(productionErrorIncidentEligible("incident-execution-failed")).toBe(
      false,
    );
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
