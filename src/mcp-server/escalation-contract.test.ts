// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import {
  escalationAnswerSchema,
  escalationQuestionSchema,
  escalationAttentionId,
  escalationKey,
  type PendingEscalation,
  validateAnswers,
  validateQuestions,
} from "./escalation-contract.js";
import {
  sampleEscalationAnswer,
  sampleEscalationQuestions,
} from "./escalation-tools.test-support.js";

const pending = (): PendingEscalation => ({
  answeringAuthority: { kind: "operator" },
  attentionId: "attention-1",
  escalationId: "choice-1",
  instanceId: "instance-1",
  openedAt: "2026-01-01T00:00:00.000Z",
  ownerSessionKey: "session-1",
  questions: sampleEscalationQuestions,
  stage: "assess",
});

describe("escalation contract", () => {
  it("separates the bounded attention identity from the lossless key", () => {
    const instanceId = "task-41";
    const ownerSessionKey = "12345678-1234-4234-8234-123456789abc";
    const escalationId = "e".repeat(128);

    expect(escalationKey(instanceId, ownerSessionKey, escalationId)).toBe(
      JSON.stringify([instanceId, ownerSessionKey, escalationId]),
    );
    const attentionId = escalationAttentionId(
      instanceId,
      ownerSessionKey,
      escalationId,
    );
    expect(attentionId).toMatch(/^escalation:[0-9a-f]{64}$/);
    expect(attentionId).toHaveLength(75);
    expect(
      escalationAttentionId(instanceId, ownerSessionKey, escalationId),
    ).toBe(attentionId);
    expect(
      new Set([
        attentionId,
        escalationAttentionId("task-43", ownerSessionKey, escalationId),
        escalationAttentionId(
          instanceId,
          "87654321-4321-4321-8321-cba987654321",
          escalationId,
        ),
        escalationAttentionId(instanceId, ownerSessionKey, "f".repeat(128)),
      ]),
    ).toHaveLength(4);
  });

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

  it("validates a value answer against its declared length", () => {
    const valueQuestion = escalationQuestionSchema.parse({
      id: "release-code",
      kind: "value",
      prompt: "Which release code should be used?",
      validation: { maxLength: 8, minLength: 4 },
    });
    const opened = { ...pending(), questions: [valueQuestion] };

    expect(() =>
      validateAnswers(opened, { "release-code": "AB12" }),
    ).not.toThrow();
    expect(() => validateAnswers(opened, { "release-code": "A12" })).toThrow(
      /value validation/,
    );
    expect(() =>
      validateAnswers(opened, { "release-code": "ABCDEFGHI" }),
    ).toThrow(/value validation/);

    const longValue = "x".repeat(256);
    expect(
      escalationAnswerSchema.parse({
        answers: { "release-code": longValue },
        escalationId: "choice-1",
        ownerSessionKey: "session-1",
      }).answers["release-code"],
    ).toBe(longValue);
  });

  it("accepts bounded prose in addition to the authoritative answer", () => {
    expect(
      escalationAnswerSchema.parse({
        answers: sampleEscalationAnswer,
        escalationId: "choice-1",
        ownerSessionKey: "session-1",
        prose: "Use the ordinary window after the current operation.",
      }),
    ).toMatchObject({
      prose: "Use the ordinary window after the current operation.",
    });
  });
});
