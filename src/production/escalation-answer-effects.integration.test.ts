// ---
// relationships:
//   verifies: heddle
// ---

import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkflowMcpSessionBinding } from "../mcp-server/index.js";
import type {
  JsonValue,
  ResolvedSessionBinding,
} from "../persistence/index.js";
import { createProductionComposition } from "./composition.js";
import {
  execute,
  prepareProductionEpicFixture,
  SyntheticT3,
} from "./composition.test-support.js";

const storedCorrelationToken = (
  handoffs: JsonValue[],
  sessionKey: string,
): string => {
  const stored = handoffs.find(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      value["kind"] === "stage-handoff" &&
      value["sessionKey"] === sessionKey,
  );
  if (
    typeof stored !== "object" ||
    stored === null ||
    Array.isArray(stored) ||
    typeof stored["correlationToken"] !== "string"
  ) {
    throw new Error("Fixture stage has no correlation token");
  }
  return stored["correlationToken"];
};

const callTool = async (
  composition: ReturnType<typeof createProductionComposition>,
  token: string,
  name: string,
  arguments_: Record<string, unknown>,
) => {
  const response = await composition.mcp.fetch(
    new globalThis.Request("http://production.invalid/mcp", {
      body: JSON.stringify({
        id: globalThis.crypto.randomUUID(),
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: arguments_, name },
      }),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
    }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    result?: { isError?: boolean; structuredContent?: unknown };
  };
};

const withoutOccurrenceIdentity = (binding: ResolvedSessionBinding) => {
  const {
    sessionKey: _sessionKey,
    threadId: _threadId,
    ...selection
  } = binding;
  void _sessionKey;
  void _threadId;
  return selection;
};

describe("production escalation answer delivery", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => cleanup?.());

  it("reactivates an unavailable top-level stage, delivers one answer turn, records the decision, and permits advance", async () => {
    const fixture = await prepareProductionEpicFixture();
    cleanup = fixture.cleanup;
    const t3 = new SyntheticT3();
    const composition = createProductionComposition({
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
    });
    cleanup = async () => {
      await composition.close();
      await fixture.cleanup();
    };
    await composition.start();
    const original = composition.persistence.listReconcilerRuntime()[0]!;
    const originalSession = composition.persistence
      .listSessionRuntime()
      .find(({ sessionKey }) => sessionKey === original.sessionKey)!;
    const instance = composition.persistence.getInstance(original.instanceId)!;
    const binding: WorkflowMcpSessionBinding = {
      dispositions: [{ description: "Finish the sample", name: "complete" }],
      instance,
      sessionKey: original.sessionKey!,
      stage: { id: original.stageId!, tools: ["advance", "escalate"] },
      taskContext: { id: fixture.taskId, title: "Arrange sample items" },
      token: storedCorrelationToken(
        instance.state.handoffs,
        original.sessionKey!,
      ),
    };

    await expect(
      composition.escalation.escalate(binding, {
        escalationId: "sample-route",
        questions: [
          {
            id: "route",
            options: [
              { description: "Use route A", id: "a", label: "Route A" },
              { description: "Use route B", id: "b", label: "Route B" },
            ],
            prompt: "Which route should be used?",
          },
        ],
      }),
    ).resolves.toEqual({ awaitingAnswer: true, escalationId: "sample-route" });
    await vi.waitFor(() =>
      expect(composition.attention.list()).toHaveLength(1),
    );
    t3.threads.delete(original.threadId!);

    const attention = composition.attention.list()[0]!;
    await composition.consoleActions.execute({
      action: attention.actions[0]!,
      answers: { route: "b" },
      attention,
      prose: "Use this route for the current sample only.",
    });

    const replacement = composition.persistence.listReconcilerRuntime()[0]!;
    expect(replacement.sessionKey).not.toBe(original.sessionKey);
    expect(replacement.threadId).not.toBe(original.threadId);
    const replacementSession = composition.persistence
      .listSessionRuntime()
      .find(({ sessionKey }) => sessionKey === replacement.sessionKey)!;
    expect(withoutOccurrenceIdentity(replacementSession.binding)).toEqual(
      withoutOccurrenceIdentity(originalSession.binding),
    );
    const answerTurns = t3.commands.filter(
      (command) =>
        command.type === "thread.turn.start" &&
        command.threadId === replacement.threadId &&
        typeof command["message"] === "object" &&
        command["message"] !== null &&
        typeof (command["message"] as Record<string, unknown>)["text"] ===
          "string" &&
        (
          (command["message"] as Record<string, unknown>)["text"] as string
        ).includes("Escalation sample-route was answered"),
    );
    expect(answerTurns).toHaveLength(1);
    const commandCount = t3.commands.length;
    await composition.escalation.replayPendingDeliveries();
    expect(t3.commands).toHaveLength(commandCount);

    const decisionSources: string[] = [];
    for (const taskId of [fixture.taskId, fixture.epicId]) {
      const shown = await execute("kanban-md", [
        "--dir",
        fixture.configuration.boardDirectory,
        "show",
        String(taskId),
        "--json",
      ]);
      const task = JSON.parse(shown.stdout) as { file: string };
      decisionSources.push(await readFile(task.file, "utf8"));
    }
    for (const source of decisionSources) {
      expect(source).toContain("Question: Which route should be used?");
      expect(source).toContain("Answer: Route B (b)");
      expect(source).toContain(
        "Prose: Use this route for the current sample only.",
      );
      expect(source).toContain("Answering authority: operator");
    }

    const replacementInstance = composition.persistence.getInstance(
      original.instanceId,
    )!;
    const replacementToken = storedCorrelationToken(
      replacementInstance.state.handoffs,
      replacement.sessionKey!,
    );
    const advanced = await callTool(composition, replacementToken, "advance", {
      disposition: "complete",
    });
    expect(advanced.result?.isError).not.toBe(true);
    expect(
      composition.persistence.getInstance(original.instanceId)?.state,
    ).toMatchObject({
      flowcraftContext: expect.objectContaining({
        awaitingNodeIds: ["review"],
        status: "awaiting",
      }),
    });
  });

  it("suppresses liveness attention and incident admission only while an awaiting session remains reachable", async () => {
    const fixture = await prepareProductionEpicFixture();
    cleanup = fixture.cleanup;
    fixture.configuration.incident.failureThreshold = 1;
    fixture.configuration.incident.retryDelayMilliseconds = 1;
    fixture.configuration.observationThresholds = {
      endedMilliseconds: 1,
      failedMilliseconds: 1,
      stalledMilliseconds: 1,
    };
    const t3 = new SyntheticT3();
    const composition = createProductionComposition({
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
    });
    cleanup = async () => {
      await composition.close();
      await fixture.cleanup();
    };
    await composition.start();
    const runtime = composition.persistence.listReconcilerRuntime()[0]!;
    const instance = composition.persistence.getInstance(runtime.instanceId)!;
    const binding: WorkflowMcpSessionBinding = {
      dispositions: [{ description: "Finish the sample", name: "complete" }],
      instance,
      sessionKey: runtime.sessionKey!,
      stage: { id: runtime.stageId!, tools: ["advance", "escalate"] },
      taskContext: { id: fixture.taskId, title: "Arrange sample items" },
      token: storedCorrelationToken(
        instance.state.handoffs,
        runtime.sessionKey!,
      ),
    };

    await composition.escalation.escalate(binding, {
      escalationId: "reachable-wait",
      questions: [
        {
          id: "route",
          options: [
            { description: "Use route A", id: "a", label: "Route A" },
            { description: "Use route B", id: "b", label: "Route B" },
          ],
          prompt: "Which route should be used?",
        },
      ],
    });
    await vi.waitFor(() =>
      expect(composition.attention.list()).toHaveLength(1),
    );
    await composition.scheduler.trigger();
    await composition.scheduler.trigger();

    expect(
      composition.attention.list().filter(({ kind }) => kind !== "escalation"),
    ).toEqual([]);
    expect(composition.persistence.listIncidentRuntime()).toEqual([]);

    t3.threads.delete(runtime.threadId!);
    await composition.scheduler.trigger();
    await composition.scheduler.trigger();
    expect(composition.attention.list()).toContainEqual(
      expect.objectContaining({
        instanceId: runtime.instanceId,
        kind: "ended",
      }),
    );
    await composition.scheduler.trigger();
    expect(composition.persistence.listIncidentRuntime()).toContainEqual(
      expect.objectContaining({
        sourceInstanceId: runtime.instanceId,
        taskId: fixture.taskId,
      }),
    );
  });
});
