// ---
// relationships:
//   validates: heddle
// ---

import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it, vi } from "vitest";

import { createConsoleAttention } from "./attention-contract.js";
import {
  type BrowserResponse,
  childTask,
  clientHarness,
  deferred,
  projection,
  response,
  rootTask,
} from "./page-client.test-support.js";

const refreshedTask = {
  blocked: false,
  dependencies: [],
  id: 12,
  parent: 10,
  priority: "medium",
  status: "done",
  tags: [],
  title: "Complete the updated item",
};

const refreshedGraph = {
  edges: [
    { from: 10, to: 11, trace: true },
    { from: 11, to: 12, trace: false },
  ],
  nodes: [
    {
      id: 10,
      layer: 0,
      priority: "medium",
      row: 0,
      status: "in-progress",
      title: "Example group",
      treatment: "running",
    },
    {
      id: 11,
      layer: 1,
      priority: "medium",
      row: 0,
      status: "in-progress",
      title: "Example item",
      treatment: "running",
    },
    {
      id: 12,
      layer: 2,
      priority: "medium",
      row: 0,
      status: "done",
      title: "Complete the updated item",
      treatment: "done",
    },
  ],
};

const informationalAttention = (attentionId: string) =>
  createConsoleAttention({
    actions: [],
    attentionId,
    instanceId: "instance-11",
    kind: "stale-work",
    message: "A sample record requires operator attention",
    scope: "task:11",
    taskId: 11,
  });

const answerableAttention = () =>
  createConsoleAttention({
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

describe("console live board polling", () => {
  it("performs no DOM mutation for two consecutive identical payloads", async () => {
    const harness = await clientHarness();
    const boardMutations = harness.board.mutationCount;
    const attentionMutations = harness.attentionList.mutationCount;

    harness.runNextTimeout();
    await vi.waitFor(() => expect(harness.projectionRequests).toHaveLength(2));
    harness.runNextTimeout();
    await vi.waitFor(() => expect(harness.projectionRequests).toHaveLength(3));

    expect(harness.board.mutationCount).toBe(boardMutations);
    expect(harness.attentionList.mutationCount).toBe(attentionMutations);
  });

  it("retains unaffected card instances when one item changes", async () => {
    const harness = await clientHarness();
    const [rootCard, childCard] = harness.cardElements();
    harness.replaceTasks([
      rootTask,
      { ...childTask, title: "Updated example item" },
    ]);

    harness.runNextTimeout();
    await vi.waitFor(() =>
      expect(harness.cardElements()[1]).not.toBe(childCard),
    );

    expect(harness.cardElements()[0]).toBe(rootCard);
  });

  it("retains focus on an unaffected card when another item changes", async () => {
    const harness = await clientHarness();
    const focused = harness.cardElements()[0]!;
    focused.focus();
    harness.replaceTasks([
      rootTask,
      { ...childTask, title: "Updated example item" },
    ]);

    harness.runNextTimeout();
    await vi.waitFor(() =>
      expect(harness.cardElements()[1]?.dataset.renderSignature).toContain(
        "Updated example item",
      ),
    );

    expect(harness.cardElements()[0]).toBe(focused);
    expect(focused.focusCount).toBe(1);
  });

  it("retains text selection on an unaffected card when another item changes", async () => {
    const harness = await clientHarness();
    const selectedTitle = harness.cardElements()[0]!.children[1]!;
    selectedTitle.dataset.selection = "0:7";
    harness.replaceTasks([
      rootTask,
      { ...childTask, title: "Updated example item" },
    ]);

    harness.runNextTimeout();
    await vi.waitFor(() =>
      expect(harness.cardElements()[1]?.dataset.renderSignature).toContain(
        "Updated example item",
      ),
    );

    expect(harness.cardElements()[0]!.children[1]).toBe(selectedTitle);
    expect(selectedTitle.dataset.selection).toBe("0:7");
  });

  it("updates the scoped board without navigation or scroll reset", async () => {
    const harness = await clientHarness(
      [rootTask, childTask],
      "http://console.test/?scope=epic%3A10",
    );
    harness.board.scrollLeft = 224;
    harness.replaceTasks([rootTask, childTask, refreshedTask]);

    harness.runNextTimeout();

    await vi.waitFor(() =>
      expect(harness.cardIds()).toEqual(["10", "11", "12"]),
    );
    expect(harness.location()).toBe("http://console.test/?scope=epic%3A10");
    expect(harness.scope.value).toBe("epic:10");
    expect(harness.board.scrollLeft).toBe(224);
    expect(harness.liveBoardStatus.textContent).toBe("LIVE BOARD");
    expect(harness.liveBoardMark.dataset.health).toBe("live");
  });

  it("updates the scoped dependency graph without navigation or scroll reset", async () => {
    const harness = await clientHarness(
      [rootTask, childTask],
      "http://console.test/?view=dependencies&scope=epic%3A10",
    );
    harness.graphViewport.scrollLeft = 224;
    harness.replaceTasks([rootTask, childTask, refreshedTask]);
    harness.replaceGraph(refreshedGraph);

    harness.runNextTimeout();

    await vi.waitFor(() =>
      expect(
        harness.graphCanvas.children
          .filter(({ tagName }) => tagName === "a")
          .map(({ dataset }) => dataset.taskId),
      ).toEqual(["10", "11", "12"]),
    );
    expect(harness.location()).toBe(
      "http://console.test/?view=dependencies&scope=epic%3A10",
    );
    expect(harness.scope.value).toBe("epic:10");
    expect(harness.graphViewport.scrollLeft).toBe(224);
  });

  it("does not announce a steady live board at each poll", async () => {
    const harness = await clientHarness();
    const statusWrites = harness.liveBoardStatus.textContentWriteCount;
    harness.replaceTasks([rootTask, childTask, refreshedTask]);

    harness.runNextTimeout();

    await vi.waitFor(() =>
      expect(harness.cardIds()).toEqual(["10", "11", "12"]),
    );
    expect(harness.liveBoardStatus.textContent).toBe("LIVE BOARD");
    expect(harness.liveBoardStatus.textContentWriteCount).toBe(statusWrites);
  });

  it("marks the board stale when scheduled updates stop", async () => {
    const harness = await clientHarness();
    const heldBoard = deferred<BrowserResponse>();
    harness.holdBoard(heldBoard.promise);

    harness.runNextTimeout();
    harness.runNextTimeout();

    await vi.waitFor(() =>
      expect(harness.liveBoardStatus.textContent).toBe("BOARD STALE"),
    );
    expect(harness.liveBoardMark.dataset.health).toBe("stale");
  });

  it("does not let an old live poll overwrite a newer scoped view", async () => {
    const harness = await clientHarness();
    const heldBoard = deferred<BrowserResponse>();
    harness.holdBoard(heldBoard.promise);
    harness.runNextTimeout();
    harness.releaseBoard();

    harness.navigate("task:11");
    await vi.waitFor(() => expect(harness.cardIds()).toEqual(["11"]));
    heldBoard.resolve(response({ tasks: [rootTask, childTask] }));

    await delay(20);
    expect(harness.cardIds()).toEqual(["11"]);
    expect(harness.board.replaceCount).toBe(0);
    expect(harness.scope.value).toBe("task:11");
    expect(harness.projectionRequests).toEqual(["all", "task:11"]);
  });

  it("does not render an old live projection after scope navigation", async () => {
    const harness = await clientHarness();
    const heldProjection = deferred<BrowserResponse>();
    harness.holdProjection("all", heldProjection.promise);
    harness.runNextTimeout();
    await vi.waitFor(() =>
      expect(
        harness.projectionRequests.filter((scope) => scope === "all"),
      ).toHaveLength(2),
    );

    harness.navigate("task:11");
    await vi.waitFor(() => expect(harness.cardIds()).toEqual(["11"]));
    heldProjection.resolve(
      response(projection([rootTask, childTask, refreshedTask])),
    );

    await delay(20);
    expect(harness.cardIds()).toEqual(["11"]);
    expect(harness.board.replaceCount).toBe(0);
    expect(harness.scope.value).toBe("task:11");
  });

  it("does not reopen dismissed linked attention while refreshing its data", async () => {
    const linkedAttention = informationalAttention("attention-11");
    const harness = await clientHarness(
      [rootTask, childTask],
      "http://console.test/?scope=all&attention=attention-11",
      undefined,
      undefined,
      [linkedAttention],
    );
    const linkedEntry = harness
      .attentionElements()
      .find(({ dataset }) => dataset.attentionId === "attention-11")!;
    const initialFocusCount = linkedEntry.focusCount;
    const initialScrollIntoViewCount = linkedEntry.scrollIntoViewCount;
    harness.attentionOverlay.close();
    harness.replaceAttention([
      linkedAttention,
      informationalAttention("attention-12"),
    ]);

    harness.runNextTimeout();

    await vi.waitFor(() => expect(harness.attention.textContent).toBe("2"));
    expect(harness.attentionOverlay.open).toBe(false);
    const refreshedEntry = harness
      .attentionElements()
      .find(({ dataset }) => dataset.attentionId === "attention-11")!;
    expect(refreshedEntry).toBe(linkedEntry);
    expect(refreshedEntry.focusCount).toBe(initialFocusCount);
    expect(refreshedEntry.scrollIntoViewCount).toBe(initialScrollIntoViewCount);
    expect(initialFocusCount).toBe(1);
    expect(initialScrollIntoViewCount).toBe(1);
  });

  it("retains an open attention disposition selection during a live refresh", async () => {
    const entry = answerableAttention();
    const harness = await clientHarness(
      [rootTask, childTask],
      "http://console.test/?scope=all&attention=attention-11",
      undefined,
      undefined,
      [entry],
    );
    const selected = harness
      .attentionElements()
      .find(({ tagName }) => tagName === "input")!;
    const action = harness
      .attentionElements()
      .find(({ className }) => className === "attention-action")!;
    const initialReplaceCount = harness.attentionList.replaceCount;
    selected.checked = true;
    harness.replaceAttention([entry, informationalAttention("attention-12")]);

    harness.runNextTimeout();

    await vi.waitFor(() => expect(harness.attention.textContent).toBe("2"));
    expect(harness.attentionList.replaceCount).toBe(initialReplaceCount);
    expect(selected.checked).toBe(true);
    action.dispatch("click");
    await vi.waitFor(() => expect(harness.attentionRequests).toHaveLength(1));
    expect(
      JSON.parse(String(harness.attentionRequests[0]?.options?.body)),
    ).toMatchObject({ answers: { "batch-size": "small" } });
  });

  it("does not render an old live dependency graph after scope navigation", async () => {
    const harness = await clientHarness(
      [rootTask, childTask],
      "http://console.test/?view=dependencies&scope=all",
    );
    const heldGraph = deferred<BrowserResponse>();
    harness.holdGraph("all", heldGraph.promise);
    harness.runNextTimeout();
    await vi.waitFor(() =>
      expect(
        harness.graphRequests.filter((scope) => scope === "all"),
      ).toHaveLength(2),
    );

    harness.navigateUrl(
      "http://console.test/?view=dependencies&scope=task%3A11",
    );
    await vi.waitFor(() =>
      expect(
        harness.graphCanvas.children
          .filter(({ tagName }) => tagName === "a")
          .map(({ dataset }) => dataset.taskId),
      ).toEqual(["11"]),
    );
    heldGraph.resolve(response(refreshedGraph));

    await delay(20);
    expect(
      harness.graphCanvas.children
        .filter(({ tagName }) => tagName === "a")
        .map(({ dataset }) => dataset.taskId),
    ).toEqual(["11"]);
    expect(harness.graphCanvas.replaceCount).toBe(0);
    expect(harness.scope.value).toBe("task:11");
  });
});
