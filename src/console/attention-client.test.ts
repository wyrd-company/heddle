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
                options: [
                  { label: "Small", value: "small" },
                  { label: "Large", value: "large" },
                ],
                prompt: "Which batch size should be used?",
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
    action!.dispatch("click");

    await vi.waitFor(() => expect(harness.attentionRequests).toHaveLength(1));
    expect(harness.attentionRequests[0]?.input).toBe(
      "/api/attention/attention-11/actions/answer",
    );
    expect(
      JSON.parse(String(harness.attentionRequests[0]?.options?.body)),
    ).toEqual({
      answers: { "batch-size": "small" },
      fingerprint: entry.fingerprint,
    });
    expect(harness.location()).toBe(
      "http://console.test/?view=dependencies&scope=epic:10&attention=attention-11",
    );
    expect(harness.boardViewLink.href).toBe(
      "/?scope=epic%3A10&attention=attention-11",
    );
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
