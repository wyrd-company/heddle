// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import {
  type PendingEscalation,
  validateAnswers,
  validateQuestions,
} from "./escalation-contract.js";
import {
  sampleEscalationAnswer,
  sampleEscalationQuestions,
} from "./escalation-tools.test-support.js";

const pending = (): PendingEscalation => ({
  attentionId: "attention-1",
  escalationId: "choice-1",
  instanceId: "instance-1",
  openedAt: "2026-01-01T00:00:00.000Z",
  ownerSessionKey: "session-1",
  questions: sampleEscalationQuestions,
  stage: "assess",
});

describe("escalation contract", () => {
  it("rejects duplicate question and option identities", () => {
    expect(() =>
      validateQuestions([
        ...sampleEscalationQuestions,
        { ...sampleEscalationQuestions[0]! },
      ]),
    ).toThrow(/repeats question ID/);
    expect(() =>
      validateQuestions([
        {
          ...sampleEscalationQuestions[0]!,
          options: [
            ...sampleEscalationQuestions[0]!.options,
            { ...sampleEscalationQuestions[0]!.options[0]! },
          ],
        },
      ]),
    ).toThrow(/repeats option ID/);
  });

  it("requires exactly one offered option for each question", () => {
    expect(() => validateAnswers(pending(), {})).toThrow(/one option/);
    expect(() =>
      validateAnswers(pending(), { "delivery-window": "unoffered" }),
    ).toThrow(/does not name an offered option/);
    expect(() =>
      validateAnswers(pending(), sampleEscalationAnswer),
    ).not.toThrow();
  });
});
