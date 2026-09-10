// ---
// relationships:
//   validates: heddle
// ---

import { describe, expect, it, vi } from "vitest";

import { createConsoleAttention } from "./attention-contract.js";
import {
  childTask,
  clientHarness,
  rootTask,
} from "./page-client.test-support.js";

const informational = (attentionId: string, kind: string) =>
  createConsoleAttention({
    actions: [],
    attentionId,
    instanceId: "instance-11",
    kind,
    message: "A sample record requires operator attention",
    scope: "task:11",
    taskId: 11,
  });

const lifecycle = {
  blueprint: {
    blobHash: "a".repeat(40),
    edges: [],
    id: "sample-process",
    nodes: [{ id: "prepare", uses: "wait" }],
    path: "blueprints/sample-process.json",
  },
  currentStageIds: ["prepare"],
  events: [],
  instanceId: "instance-11",
  nextSequence: 0,
  status: "awaiting",
  taskId: 11,
};

describe("global console attention overlay", () => {
  it.each([
    ["board", "http://console.test/?scope=all&attention=attention-11", "all"],
    [
      "dependencies",
      "http://console.test/?view=dependencies&scope=epic:10&attention=attention-11",
      "epic:10",
    ],
    [
      "lifecycle",
      "http://console.test/?view=lifecycle&task=11&scope=all&attention=attention-11",
      "all",
    ],
  ])(
    "opens and focuses the linked entry on the %s view",
    async (view, url, expectedScope) => {
      const harness = await clientHarness(
        [rootTask, childTask],
        url,
        undefined,
        view === "lifecycle" ? lifecycle : undefined,
        [informational("attention-11", "stale-work")],
      );

      const entry = harness
        .attentionElements()
        .find(({ dataset }) => dataset.attentionId === "attention-11");
      expect(harness.attentionOverlay.open).toBe(true);
      expect(entry?.dataset.focused).toBe("true");
      expect(entry?.dataset.focusedByTest).toBe("true");
      expect(harness.scope.value).toBe(expectedScope);
      expect(harness.location()).toBe(url);
    },
  );

  it("renders the exact current badge count and informational states", async () => {
    const entries = [
      informational("attention-escalation", "escalation"),
      informational("attention-stale", "stale-work"),
      informational("attention-approval", "approval"),
      informational("attention-uat", "uat"),
    ];
    const harness = await clientHarness(
      [rootTask, childTask],
      undefined,
      undefined,
      undefined,
      entries,
    );

    expect(harness.attention.textContent).toBe("4");
    expect(
      harness
        .attentionElements()
        .filter(({ dataset }) => dataset.attentionId !== undefined),
    ).toHaveLength(4);
    expect(harness.attentionStatus.textContent).toBe(
      "4 items require operator attention",
    );
  });

  it("posts only the selected offered answer and current fingerprint", async () => {
    const entry = createConsoleAttention({
      actions: [
        {
          actionId: "answer",
          contract: {
            escalationId: "sample-choice",
            instanceId: "instance-11",
            kind: "escalation.answer",
            ownerSessionKey: "sample-session",
          },
          input: {
            kind: "questions",
            questions: [
              {
                header: "Batch size",
                id: "batch-size",
                multiSelect: false,
                options: [{ label: "Small" }, { label: "Large" }],
                question: "Which batch size should be used?",
              },
            ],
          },
          label: "Answer",
        },
      ],
      attentionId: "attention-11",
      instanceId: "instance-11",
      kind: "escalation",
      message: "A sample choice is required",
      scope: "task:11",
      taskId: 11,
    });
    const harness = await clientHarness(
      [rootTask, childTask],
      "http://console.test/?view=dependencies&scope=epic:10&attention=attention-11",
      undefined,
      undefined,
      [entry],
    );
    const elements = harness.attentionElements();
    const inputs = elements.filter(({ tagName }) => tagName === "input");
    const action = elements.find(
      ({ className }) => className === "attention-action",
    );
    expect(
      elements.find(({ tagName }) => tagName === "legend")?.textContent,
    ).toBe("Batch size — Which batch size should be used?");
    inputs[0]!.checked = true;
    elements.find(({ name }) => name === "batch-size:reasoning")!.value =
      "Fits the available ingredients.";
    action!.dispatch("click");

    await vi.waitFor(() => expect(harness.attentionRequests).toHaveLength(1));
    expect(harness.attentionRequests[0]?.input).toBe(
      "/api/attention/attention-11/actions/answer",
    );
    expect(
      JSON.parse(String(harness.attentionRequests[0]?.options?.body)),
    ).toEqual({
      answers: {
        "batch-size": {
          selectedOptions: ["Small"],
          text: "",
          reasoning: "Fits the available ingredients.",
        },
      },
      fingerprint: entry.fingerprint,
    });
    expect(harness.location()).toBe(
      "http://console.test/?view=dependencies&scope=epic:10&attention=attention-11",
    );
    expect(harness.boardViewLink.href).toBe(
      "/?scope=epic%3A10&attention=attention-11",
    );
  });

  it("submits an explicit empty answer set for an empty question set", async () => {
    const entry = createConsoleAttention({
      actions: [
        {
          actionId: "answer",
          contract: {
            escalationId: "sample-empty",
            instanceId: "instance-11",
            kind: "escalation.answer",
            ownerSessionKey: "sample-session",
          },
          input: { kind: "questions", questions: [] },
          label: "Answer",
        },
      ],
      attentionId: "attention-empty",
      instanceId: "instance-11",
      kind: "escalation",
      message: "An empty sample answer is required",
      scope: "task:11",
      taskId: 11,
    });
    const harness = await clientHarness(
      [rootTask, childTask],
      undefined,
      undefined,
      undefined,
      [entry],
    );
    harness
      .attentionElements()
      .find(({ className }) => className === "attention-action")!
      .dispatch("click");

    await vi.waitFor(() => expect(harness.attentionRequests).toHaveLength(1));
    expect(
      JSON.parse(String(harness.attentionRequests[0]?.options?.body)),
    ).toEqual({ answers: {}, fingerprint: entry.fingerprint });
  });

  it("renders notification verification before the Retry action", async () => {
    const entry = createConsoleAttention({
      actions: [
        {
          actionId: "notification.retry",
          contract: { kind: "notification.retry", occurrence: 1 },
          input: { kind: "none" },
          label: "Retry notification",
        },
      ],
      attentionId: "notification-recovery",
      instanceId: "instance-11",
      kind: "production-error",
      message: "Notification delivery requires recovery.",
      notificationVerification: {
        message: "A sample needs attention",
        recipientLabel: "Primary operator",
      },
      scope: "task:11",
      taskId: 11,
    });
    const harness = await clientHarness(
      [rootTask, childTask],
      undefined,
      undefined,
      undefined,
      [entry],
    );
    const elements = harness.attentionElements();
    const verification = elements.find(
      ({ className }) => className === "attention-notification-verification",
    );
    const action = elements.find(
      ({ className }) => className === "attention-action",
    );

    expect(verification).toBeDefined();
    expect(
      verification!.children.map(({ textContent }) => textContent),
    ).toEqual([
      "Recipient",
      "Primary operator",
      "Intended message",
      "A sample needs attention",
    ]);
    expect(action?.textContent).toBe("Retry notification →");
  });

  it.each([
    [false, "reference"],
    [true, "reference"],
    [false, "__proto__"],
  ] as const)(
    "switches options and text while retaining reasoning (multiSelect=%s, id=%s)",
    async (multiSelect, referenceId) => {
      const entry = createConsoleAttention({
        actions: [
          {
            actionId: "answer",
            label: "Answer",
            contract: {
              kind: "escalation.answer",
              escalationId: "sample",
              instanceId: "instance-11",
              ownerSessionKey: "sample-session",
            },
            input: {
              kind: "questions",
              questions: [
                {
                  id: "choice",
                  question: "Choose ingredients",
                  multiSelect,
                  options: [{ label: "First" }, { label: "Second" }],
                },
                {
                  id: referenceId,
                  question: "Enter a reference",
                  multiSelect: false,
                  options: [],
                },
              ],
            },
          },
        ],
        attentionId: "attention-11",
        instanceId: "instance-11",
        kind: "escalation",
        message: "Sample input needed",
        scope: "task:11",
        taskId: 11,
      });
      const harness = await clientHarness(
        [rootTask, childTask],
        undefined,
        undefined,
        undefined,
        [entry],
      );
      const elements = harness.attentionElements();
      const options = elements.filter(({ tagName }) => tagName === "input");
      expect(options.map(({ type }) => type)).toEqual([
        multiSelect ? "checkbox" : "radio",
        multiSelect ? "checkbox" : "radio",
      ]);
      const answerText = elements.find(({ name }) => name === "choice:text")!;
      const reasoning = elements.find(
        ({ name }) => name === "choice:reasoning",
      )!;
      const reference = elements.find(
        ({ name }) => name === `${referenceId}:text`,
      )!;
      const referenceReasoning = elements.find(
        ({ name }) => name === `${referenceId}:reasoning`,
      )!;
      const action = elements.find(
        ({ className }) => className === "attention-action",
      )!;
      reasoning.value = "Fits the recipe.";
      options[0]!.checked = true;
      options[0]!.dispatch("change");
      options[1]!.checked = true;
      options[1]!.dispatch("change");
      expect(options[0]!.checked).toBe(multiSelect);
      answerText.value = "A different ingredient";
      answerText.dispatch("input");
      expect(options.every(({ checked }) => !checked)).toBe(true);
      expect(reasoning.value).toBe("Fits the recipe.");
      options[0]!.checked = true;
      options[0]!.dispatch("change");
      expect(answerText.value).toBe("");
      expect(reasoning.value).toBe("Fits the recipe.");
      reference.value = "sample-12";
      action.dispatch("click");
      expect(harness.attentionRequests).toHaveLength(0);
      expect(harness.attentionStatus.textContent).toContain(
        "Enter reasoning for Enter a reference",
      );
      referenceReasoning.value = "Matches the sample label.";
      action.dispatch("click");
      await vi.waitFor(() => expect(harness.attentionRequests).toHaveLength(1));
      expect(
        JSON.parse(String(harness.attentionRequests[0]?.options?.body)),
      ).toEqual({
        fingerprint: entry.fingerprint,
        answers: {
          choice: {
            selectedOptions: ["First"],
            text: "",
            reasoning: "Fits the recipe.",
          },
          [referenceId]: {
            selectedOptions: [],
            text: "sample-12",
            reasoning: "Matches the sample label.",
          },
        },
      });
    },
  );

  it("links an originating production error to its incident lifecycle canvas", async () => {
    const entry = createConsoleAttention({
      actions: [],
      attentionId: "production-error-11",
      incidentId: "incident:synthetic-11",
      instanceId: "instance-11",
      kind: "production-error",
      message: "A synthetic production condition needs diagnosis",
      scope: "task:11",
      taskId: 11,
    });
    const harness = await clientHarness(
      [rootTask, childTask],
      undefined,
      undefined,
      undefined,
      [entry],
    );
    const link = harness
      .attentionElements()
      .find(({ className }) => className === "attention-incident-link");

    expect(link?.textContent).toBe("Open incident lifecycle →");
    expect(link?.href).toBe(
      "/?view=lifecycle&task=11&scope=task%3A11&instance=incident%3Asynthetic-11",
    );
    expect(link?.getAttribute("aria-label")).toBe(
      "Open incident lifecycle for task #11",
    );
  });
});
