// ---
// relationships:
//   verifies: heddle
// ---
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  escalationQuestionSchema,
  escalationInputSchema,
  escalationAnswerSchema,
  escalationAttentionId,
  escalationKey,
  renderQuestionSet,
  sameAnswers,
  validateAnswers,
  validateQuestions,
  type PendingEscalation,
} from "./escalation-contract.js";

const question = (
  options: string[] = ["First", "Second"],
  multiSelect = false,
) =>
  escalationQuestionSchema.parse({
    id: "route",
    question: "Which route?",
    options: options.map((label) => ({ label })),
    multiSelect,
  });
const opened = (): PendingEscalation => ({
  answeringAuthority: { kind: "operator" },
  attentionId: "attention-one",
  escalationId: "request-one",
  instanceId: "instance-one",
  openedAt: "2026-01-01T00:00:00Z",
  ownerSessionKey: "session-one",
  requestId: "request-one",
  threadId: "thread-one",
  stage: "assess",
  questions: [question()],
});
const answer = (
  selectedOptions: string[] = ["First"],
  text = "",
  reasoning = "The first route fits.",
) => ({ selectedOptions, text, reasoning });

describe("one question contract", () => {
  it("separates bounded attention identity from its lossless request key", () => {
    expect(escalationKey("instance", "owner", "r".repeat(128))).toBe(
      JSON.stringify(["instance", "owner", "r".repeat(128)]),
    );
    const ids = ["first", "second"].map((id) =>
      escalationAttentionId("instance", "owner", id),
    );
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^escalation:[0-9a-f]{64}$/);
  });
  it("defaults omitted multiSelect to false and accepts zero or one option", () => {
    for (const options of [[], [{ label: "Only" }]])
      expect(
        escalationQuestionSchema.parse({
          id: "route",
          question: "Which route?",
          options,
        }),
      ).toMatchObject({ multiSelect: false, options });
  });
  it.each([0, 21])(
    "preserves the native question count %s without a Heddle-only bound",
    (count) => {
      const questions = Array.from({ length: count }, (_, index) => ({
        ...question([]),
        id: `reference-${index}`,
      }));
      expect(
        escalationInputSchema.parse({
          escalationId: "native-request",
          requestId: "native-request",
          threadId: "native-thread",
          questions,
        }).questions,
      ).toEqual(questions);
      if (count === 0) {
        expect(() =>
          validateAnswers({ ...opened(), questions }, {}),
        ).not.toThrow();
        expect(renderQuestionSet({ ...opened(), questions })).toContain(
          "Explicitly adjudicate it with answers: {}",
        );
      }
    },
  );
  it("preserves exact harness question IDs and option labels across answers", () => {
    const native = escalationQuestionSchema.parse({
      id: " route ",
      question: " Which route? ",
      options: [{ label: " First " }],
    });
    expect(native.id).toBe(" route ");
    expect(native.options[0]!.label).toBe(" First ");
    const answers = escalationAnswerSchema.shape.answers.parse({
      " route ": answer([" First "]),
    });
    expect(Object.keys(answers)).toEqual([" route "]);
    expect(() =>
      validateAnswers({ ...opened(), questions: [native] }, answers),
    ).not.toThrow();
  });
  it("rejects duplicate question IDs and option labels", () => {
    expect(() => validateQuestions([question(), question()])).toThrow(
      /repeats question/,
    );
    expect(() => validateQuestions([question(["First", "First"])])).toThrow(
      /repeats option/,
    );
  });
  it("preserves prototype-like native question IDs in the parsed answer set", () => {
    const native = { ...question([]), id: "__proto__" };
    const answers = escalationAnswerSchema.shape.answers.parse(
      Object.fromEntries([[native.id, answer([], "A route")]]),
    );
    expect(Object.hasOwn(answers, native.id)).toBe(true);
    expect(() =>
      validateAnswers({ ...opened(), questions: [native] }, answers),
    ).not.toThrow();
  });
  it("publishes the required whole-answer entry fields in the MCP JSON schema", () => {
    const json = z.toJSONSchema(escalationAnswerSchema);
    expect(json.properties?.answers).toMatchObject({
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["selectedOptions", "text", "reasoning"],
        additionalProperties: false,
        properties: {
          selectedOptions: { type: "array" },
          text: { type: "string" },
          reasoning: { type: "string" },
        },
      },
    });
  });
  it.each([
    ["missing answer", {}],
    ["unknown question", { route: answer(), extra: answer() }],
    ["substituted question", { extra: answer() }],
    ["selection and text", { route: answer(["First"], "A custom route") }],
    ["neither selection nor text", { route: answer([], "") }],
    ["whitespace text", { route: answer([], "  ") }],
    ["multiple single-select answers", { route: answer(["First", "Second"]) }],
    ["unknown option", { route: answer(["Third"]) }],
    ["duplicate option", { route: answer(["First", "First"]) }],
    ["missing reasoning", { route: { selectedOptions: ["First"], text: "" } }],
    ["empty reasoning", { route: answer(["First"], "", "") }],
    ["blank reasoning", { route: answer(["First"], "", "  ") }],
    [
      "missing selections field",
      { route: { text: "A route", reasoning: "Fits" } },
    ],
    [
      "missing text field",
      { route: { selectedOptions: ["First"], reasoning: "Fits" } },
    ],
  ])("rejects %s", (_name, answers) =>
    expect(() => validateAnswers(opened(), answers as never)).toThrow(),
  );
  it("accepts a single option for multi-select and free text for any question", () => {
    for (const multiSelect of [true, false]) {
      const pending = {
        ...opened(),
        questions: [question(undefined, multiSelect)],
      };
      expect(() => validateAnswers(pending, { route: answer() })).not.toThrow();
      expect(() =>
        validateAnswers(pending, { route: answer([], "A custom route") }),
      ).not.toThrow();
    }
  });
  it.each([
    ["missing question", {}],
    ["substituted question", { extra: answer() }],
  ])(
    "reports complete-set validation for %s instead of dereferencing an absent entry",
    (_case, answers) => {
      expect(() => validateAnswers(opened(), answers as never)).toThrow(
        "Escalation answer must answer every question exactly once",
      );
    },
  );
  it("rejects duplicate selections even when multiple distinct selections are allowed", () => {
    const pending = { ...opened(), questions: [question(undefined, true)] };
    expect(() =>
      validateAnswers(pending, { route: answer(["First", "First"]) }),
    ).toThrow(/offered option/);
    expect(() =>
      validateAnswers(pending, { route: answer(["First", "Second"]) }),
    ).not.toThrow();
  });
  it("requires text for a zero-option question without imposing length bounds", () => {
    const pending = { ...opened(), questions: [question([])] };
    expect(() => validateAnswers(pending, { route: answer() })).toThrow(
      /offered option/,
    );
    expect(() =>
      validateAnswers(pending, { route: answer([], "x".repeat(5000)) }),
    ).not.toThrow();
  });
  it("quotes identifiers cardinality text alternative and the complete answer tool contract", () => {
    const prompt = renderQuestionSet({
      ...opened(),
      questions: [question([], true)],
    });
    for (const fragment of [
      "Question ID: route",
      "Which route?",
      "one or more",
      "text answer",
      "answer tool",
      "selectedOptions",
      "reasoning",
      "ownerSessionKey",
      "escalationId",
    ])
      expect(prompt).toContain(fragment);
  });
  it("binds replay to selected answers and reasoning", () => {
    const left = {
      answers: { route: answer() },
      answeredBy: { kind: "operator" as const },
      escalationId: "request-one",
      ownerSessionKey: "session-one",
    };
    expect(sameAnswers(opened(), left, globalThis.structuredClone(left))).toBe(
      true,
    );
    expect(
      sameAnswers(opened(), left, {
        ...left,
        answers: { route: answer(["First"], "", "A different rationale") },
      }),
    ).toBe(false);
  });
});
