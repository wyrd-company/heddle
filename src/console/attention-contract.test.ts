// ---
// relationships:
//   validates: heddle
// ---

import { describe, expect, it } from "vitest";

import {
  CONSOLE_ATTENTION_KIND_LABELS,
  consoleAttentionDeepLink,
  consoleAttentionFingerprint,
  consoleAttentionHeading,
  createConsoleAttention,
  MAXIMUM_CONSOLE_ATTENTION_IDENTIFIER_LENGTH,
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
        options: [{ label: "Continue" }, { label: "Wait" }],
        question: "Which delivery window should be used?",
      },
    ],
  },
  label: "Answer escalation",
};

const entryState = () => ({
  actions: [action],
  attentionId: "attention-12",
  instanceId: "instance-12",
  kind: "escalation",
  message: "A delivery choice is required",
  scope: "task:12" as const,
  taskId: 12,
});

const entry = () => createConsoleAttention(entryState());

describe("console attention action contract", () => {
  it("emits the canonical lifecycle route for task-scoped attention", () => {
    expect(consoleAttentionDeepLink("https://console.test/base", entry())).toBe(
      "https://console.test/?view=lifecycle&task=12&scope=all&attention=attention-12",
    );
  });

  it.each([
    ["all", "https://console.test/?scope=all&attention=attention-12"],
    ["epic:12", "https://console.test/?scope=epic%3A12&attention=attention-12"],
  ] as const)("retains the %s attention route", (scope, expected) => {
    expect(
      consoleAttentionDeepLink("https://console.test/base", {
        attentionId: "attention-12",
        scope,
      }),
    ).toBe(expected);
  });

  it("changes the fingerprint when current state or offered action changes", () => {
    const original = entry();
    const changedMessage = createConsoleAttention({
      ...entryState(),
      message: "A different choice is required",
    });
    const changedAction = createConsoleAttention({
      ...entryState(),
      actions: [{ ...action, actionId: "choose" }],
    });

    expect(changedMessage.fingerprint).not.toBe(original.fingerprint);
    expect(changedAction.fingerprint).not.toBe(original.fingerprint);
  });

  it.each([
    ["approval", "task:12", "Approval request — Task 12"],
    ["blueprint-repository", "all", "Blueprint repository — All work"],
    ["ended", "task:12", "Session ended — Task 12"],
    ["escalation", "task:12", "Escalation — Task 12"],
    ["failed", "task:12", "Session failed — Task 12"],
    ["epic-acceptance", "epic:12", "Epic acceptance — Epic 12"],
    ["lifecycle-resolution", "task:12", "Lifecycle resolution — Task 12"],
    ["production-error", "task:12", "Production error — Task 12"],
    ["stalled", "task:12", "Session stalled — Task 12"],
    ["stale-instance", "task:12", "Stale instance — Task 12"],
    ["user-input", "task:12", "User input — Task 12"],
  ] as const)("names %s attention in its %s scope", (kind, scope, heading) => {
    expect(consoleAttentionHeading({ kind, scope })).toBe(heading);
    expect(Object.keys(CONSOLE_ATTENTION_KIND_LABELS)).toContain(kind);
  });

  it("keeps durable identity out of the generated heading", () => {
    const attentionId = "internal-attention-".padEnd(128, "x");
    const projected = createConsoleAttention({
      actions: [],
      attentionId,
      instanceId: "internal-session-".padEnd(128, "y"),
      kind: "production-error",
      message: "A sample record requires inspection",
      scope: "task:12",
      taskId: 12,
    });

    expect(projected.heading).toBe("Production error — Task 12");
    expect(projected.heading).not.toContain(attentionId);
    expect(projected.heading).not.toContain(projected.instanceId);
    expect(projected.heading).not.toContain(projected.fingerprint);
  });

  it("rejects a heading that is not derived from kind and scope", () => {
    const changed = {
      ...entryState(),
      heading: "Attention attention-12",
    };

    expect(() =>
      validateConsoleAttentionCatalog(
        [
          {
            ...changed,
            fingerprint: consoleAttentionFingerprint(changed),
          },
        ],
        true,
      ),
    ).toThrow("heading that does not match its kind and scope");
  });

  it("accepts exactly one offered answer for every question", () => {
    expect(
      parseConsoleAttentionActionRequest(
        {
          answers: {
            "delivery-window": {
              selectedOptions: ["Continue"],
              text: "",
              reasoning: "Fits the sample schedule.",
            },
          },
          fingerprint: entry().fingerprint,
        },
        action,
      ),
    ).toEqual({
      answers: {
        "delivery-window": {
          selectedOptions: ["Continue"],
          text: "",
          reasoning: "Fits the sample schedule.",
        },
      },
      fingerprint: entry().fingerprint,
    });
    expect(() =>
      parseConsoleAttentionActionRequest(
        {
          answers: {
            "delivery-window": {
              selectedOptions: ["Later"],
              text: "",
              reasoning: "Fits the sample schedule.",
            },
          },
          fingerprint: entry().fingerprint,
        },
        action,
      ),
    ).toThrow("does not name an offered option");
  });

  it("accepts text with reasoning when no options are offered", () => {
    const valueAction: ConsoleAttentionAction = {
      ...action,
      input: {
        kind: "questions",
        questions: [
          {
            id: "reference",
            multiSelect: false,
            question: "Enter the sample reference",
            options: [],
          },
        ],
      },
    };

    expect(
      parseConsoleAttentionActionRequest(
        {
          answers: {
            reference: {
              selectedOptions: [],
              text: "alpha-12",
              reasoning: "Matches the sample label.",
            },
          },
          fingerprint: entry().fingerprint,
        },
        valueAction,
      ),
    ).toEqual({
      answers: {
        reference: {
          selectedOptions: [],
          text: "alpha-12",
          reasoning: "Matches the sample label.",
        },
      },
      fingerprint: entry().fingerprint,
    });
    expect(() =>
      parseConsoleAttentionActionRequest(
        {
          answers: {
            reference: {
              selectedOptions: ["alpha-12"],
              text: "",
              reasoning: "Matches the sample label.",
            },
          },
          fingerprint: entry().fingerprint,
        },
        valueAction,
      ),
    ).toThrow("does not name an offered option");
  });

  it.each([
    [{ selectedOptions: [], text: "", reasoning: "Needed." }, "exclusively"],
    [
      { selectedOptions: ["Continue"], text: "Later", reasoning: "Needed." },
      "exclusively",
    ],
    [
      { selectedOptions: ["Continue"], text: "", reasoning: " " },
      "nonempty reasoning",
    ],
    [
      { selectedOptions: ["Continue", "Wait"], text: "", reasoning: "Needed." },
      "at most one",
    ],
    [
      {
        selectedOptions: ["Continue", "Continue"],
        text: "",
        reasoning: "Needed.",
      },
      "at most one",
    ],
    [
      {
        selectedOptions: [],
        text: "Later",
        reasoning: "Needed.",
        value: "old",
      },
      "requires selectedOptions",
    ],
    ["Continue", "must be an object"],
  ])("rejects invalid answer %j", (answer, message) => {
    expect(() =>
      parseConsoleAttentionActionRequest(
        {
          answers: { "delivery-window": answer },
          fingerprint: entry().fingerprint,
        },
        action,
      ),
    ).toThrow(message);
  });

  it("accepts one selection for multi-select and rejects duplicate selections", () => {
    if (action.input.kind !== "questions")
      throw new Error("questions expected");
    const multiAction: ConsoleAttentionAction = {
      ...action,
      input: {
        kind: "questions",
        questions: action.input.questions.map((question) => ({
          ...question,
          multiSelect: true,
        })),
      },
    };
    const answer = {
      selectedOptions: ["Continue"],
      text: "",
      reasoning: "Fits the schedule.",
    };
    expect(
      parseConsoleAttentionActionRequest(
        {
          answers: { "delivery-window": answer },
          fingerprint: entry().fingerprint,
        },
        multiAction,
      ).answers,
    ).toEqual({ "delivery-window": answer });
    expect(() =>
      parseConsoleAttentionActionRequest(
        {
          answers: {
            "delivery-window": {
              ...answer,
              selectedOptions: ["Continue", "Continue"],
            },
          },
          fingerprint: entry().fingerprint,
        },
        multiAction,
      ),
    ).toThrow("repeats an option");
  });

  it.each([
    {},
    { unknown: { selectedOptions: [], text: "sample", reasoning: "Needed." } },
  ])("rejects incomplete or unknown question IDs", (answers) => {
    expect(() =>
      parseConsoleAttentionActionRequest(
        { answers, fingerprint: entry().fingerprint },
        action,
      ),
    ).toThrow("every offered question exactly once");
  });

  it("carries an identity of exactly the bound and refuses one past it", () => {
    const sized = (length: number) =>
      createConsoleAttention({
        actions: [],
        attentionId: "a".repeat(length),
        kind: "blueprint-repository",
        message: "The organization blueprint repository needs attention",
        scope: "all",
      });

    expect(() =>
      validateConsoleAttentionCatalog(
        [sized(MAXIMUM_CONSOLE_ATTENTION_IDENTIFIER_LENGTH)],
        false,
      ),
    ).not.toThrow();
    expect(() =>
      validateConsoleAttentionCatalog(
        [sized(MAXIMUM_CONSOLE_ATTENTION_IDENTIFIER_LENGTH + 1)],
        false,
      ),
    ).toThrow(
      `attentionId must be a non-empty string of at most ${MAXIMUM_CONSOLE_ATTENTION_IDENTIFIER_LENGTH} characters`,
    );
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
