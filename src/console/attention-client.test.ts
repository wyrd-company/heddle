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
    ["board", "http://console.test/?scope=task:11&attention=attention-11"],
    [
      "dependencies",
      "http://console.test/?view=dependencies&scope=task:11&attention=attention-11",
    ],
    [
      "lifecycle",
      "http://console.test/?view=lifecycle&scope=task:11&attention=attention-11",
    ],
  ])("opens and focuses the linked entry on the %s view", async (view, url) => {
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
    expect(harness.scope.value).toBe("task:11");
    expect(harness.location()).toBe(url);
  });

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
      "http://console.test/?view=dependencies&scope=task:11&attention=attention-11",
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
      "http://console.test/?view=dependencies&scope=task:11&attention=attention-11",
    );
    expect(harness.boardViewLink.href).toBe(
      "/?scope=task%3A11&attention=attention-11",
    );
  });
});
