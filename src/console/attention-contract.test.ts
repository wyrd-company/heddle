// ---
// relationships:
//   validates: heddle
// ---

import { describe, expect, it } from "vitest";

import {
  consoleAttentionDeepLink,
  createConsoleAttention,
  parseConsoleAttentionActionRequest,
  validateConsoleAttentionCatalog,
} from "./attention-contract.js";
import type { ConsoleAttentionAction } from "./types.js";

const action: ConsoleAttentionAction = {
  actionId: "answer",
  contract: {
    escalationId: "sample-choice",
    instanceId: "instance-12",
    kind: "escalation.answer",
    ownerSessionKey: "session-12",
  },
  input: {
    kind: "questions",
    questions: [
      {
        id: "delivery-window",
        multiSelect: false,
        options: [
          { label: "Continue", value: "continue" },
          { label: "Wait", value: "wait" },
        ],
        prompt: "Which delivery window should be used?",
      },
    ],
  },
  label: "Answer escalation",
};

const entry = () =>
  createConsoleAttention({
    actions: [action],
    attentionId: "attention-12",
    instanceId: "instance-12",
    kind: "escalation",
    message: "A delivery choice is required",
    scope: "task:12",
    taskId: 12,
  });

describe("console attention action contract", () => {
  it("binds deep links to the stable attention identity and scope", () => {
    expect(consoleAttentionDeepLink("https://console.test/base", entry())).toBe(
      "https://console.test/?scope=task%3A12&attention=attention-12",
    );
  });

  it("changes the fingerprint when current state or offered action changes", () => {
    const original = entry();
    const changedMessage = createConsoleAttention({
      ...original,
      fingerprint: undefined as never,
      message: "A different choice is required",
    });
    const changedAction = createConsoleAttention({
      ...original,
      actions: [{ ...action, actionId: "choose" }],
      fingerprint: undefined as never,
    });

    expect(changedMessage.fingerprint).not.toBe(original.fingerprint);
    expect(changedAction.fingerprint).not.toBe(original.fingerprint);
  });

  it("accepts exactly one offered answer for every question", () => {
    expect(
      parseConsoleAttentionActionRequest(
        {
          answers: { "delivery-window": "continue" },
          fingerprint: entry().fingerprint,
        },
        action,
      ),
    ).toEqual({
      answers: { "delivery-window": "continue" },
      fingerprint: entry().fingerprint,
    });
    expect(() =>
      parseConsoleAttentionActionRequest(
        {
          answers: { "delivery-window": "later" },
          fingerprint: entry().fingerprint,
        },
        action,
      ),
    ).toThrow("does not name an offered option");
  });

  it("fails closed for duplicate identities and missing action composition", () => {
    expect(() =>
      validateConsoleAttentionCatalog([entry(), entry()], true),
    ).toThrow("is duplicated");
    expect(() => validateConsoleAttentionCatalog([entry()], false)).toThrow(
      "actions are not active",
    );
  });
});
