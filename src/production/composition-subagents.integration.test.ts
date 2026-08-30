// ---
// relationships:
//   verifies: heddle
// ---

import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkflowMcpSessionResolver } from "../mcp-server/index.js";
import type { JsonValue } from "../persistence/index.js";
import { isTodoState } from "../todo/index.js";
import { createProductionComposition } from "./composition.js";
import {
  prepareProductionFixture,
  SyntheticT3,
} from "./composition.test-support.js";
import { productionSessionTargets } from "./subagent-composition.js";

const storedCorrelationToken = (handoffs: JsonValue[]): string => {
  const stored = handoffs.find(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      value["kind"] === "stage-handoff" &&
      typeof value["correlationToken"] === "string",
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

describe("production subagent composition", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
  });

  it("shares persistence, pacing, bootstrap, observation, and token authority", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const t3 = new SyntheticT3();
    const composition = createProductionComposition({
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    });
    await composition.start();
    const instanceId = `task-${fixture.taskId}`;
    const parentRecord = composition.persistence.getInstance(instanceId)!;
    const resolver = new WorkflowMcpSessionResolver(composition.persistence);
    const parent = await resolver.resolve(
      storedCorrelationToken(parentRecord.state.handoffs),
    );
    const toolsResponse = await composition.mcp.fetch(
      new globalThis.Request("http://production.invalid/mcp", {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/list",
          params: {},
        }),
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${parent.token}`,
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );
    expect(toolsResponse.status).toBe(200);
    const toolsBody = (await toolsResponse.json()) as {
      result?: { tools?: Array<{ name: string }> };
    };
    expect(toolsBody.result?.tools?.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["liveness", "spawn"]),
    );
    const parentRuntime = composition.persistence
      .listSessionRuntime()
      .find(({ sessionKey }) => sessionKey === parent.sessionKey)!;

    const spawned = await composition.subagents.spawn(parent, {
      model: "sample-child-model",
      operationId: "spawn-child-one",
      provider: "codex",
      rootItemId: "deliver",
    });
    expect(spawned).toMatchObject({
      assignment: {
        depth: 1,
        parentSessionKey: parent.sessionKey,
        provider: "codex",
        rootItemId: "deliver",
        status: "active",
      },
      kind: "spawned",
    });
    if (spawned.kind !== "spawned") throw new Error("Child was deferred");
    const child = await resolver.resolve(spawned.assignment.correlationToken);
    expect(child.todoAssignment).toEqual({
      listSessionKey: parent.sessionKey,
      rootItemId: "deliver",
    });
    const childCreate = t3.commands.find(
      (command) =>
        command.type === "thread.create" &&
        command.threadId === spawned.assignment.threadId,
    );
    expect(childCreate).toMatchObject({
      branch: `heddle/task-${fixture.taskId}`,
      projectId: fixture.configuration.adHocProject.projectId,
      title: expect.stringContaining(`task-${fixture.taskId}`),
    });
    expect(childCreate?.worktreePath).toBe(
      t3.commands.find(
        (command) =>
          command.type === "thread.create" &&
          command.threadId === parentRuntime.threadId,
      )?.worktreePath,
    );
    const childTurn = t3.commands.find(
      (command) =>
        command.type === "thread.turn.start" &&
        command.threadId === spawned.assignment.threadId,
    );
    expect(childTurn).not.toHaveProperty("titleSeed");

    await expect(
      composition.subagents.spawn(parent, {
        model: "sample-child-model",
        operationId: "spawn-child-two",
        provider: "codex",
        rootItemId: "deliver",
      }),
    ).resolves.toMatchObject({
      deferral: { reason: "subagent-fan-out-limit" },
      kind: "deferred",
    });
    await expect(
      composition.subagents.spawn(child, {
        model: "sample-grandchild-model",
        operationId: "spawn-grandchild",
        provider: "codex",
        rootItemId: "deliver",
      }),
    ).resolves.toMatchObject({
      deferral: { reason: "subagent-depth-limit" },
      kind: "deferred",
    });

    t3.threads.delete(spawned.assignment.threadId);
    await composition.scheduler.trigger();
    const state = composition.persistence.getInstance(instanceId)!.state;
    expect(isTodoState(state.todoState)).toBe(true);
    if (!isTodoState(state.todoState)) throw new Error("Todo state is absent");
    expect(
      state.todoState.lists.flatMap((list) => list.assignments ?? []),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionKey: spawned.assignment.sessionKey,
          status: "stopped",
          stopNotification: expect.objectContaining({ status: "completed" }),
        }),
      ]),
    );
    expect(t3.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: parentRuntime.threadId,
          type: "thread.turn.start",
        }),
      ]),
    );
    await composition.close();
  });

  it("uses a delegated provider and model through shared pacing and bootstrap", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const t3 = new SyntheticT3();
    const composition = createProductionComposition({
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    });
    await composition.start();
    const record = composition.persistence.getInstance(
      `task-${fixture.taskId}`,
    )!;
    const parent = await new WorkflowMcpSessionResolver(
      composition.persistence,
    ).resolve(storedCorrelationToken(record.state.handoffs));

    const spawned = await composition.subagents.spawn(parent, {
      model: "sample-model",
      operationId: "delegated-provider",
      provider: "other-provider",
      rootItemId: "deliver",
    });
    expect(spawned).toMatchObject({
      assignment: { model: "sample-model", provider: "other-provider" },
      kind: "spawned",
    });
    if (spawned.kind !== "spawned") throw new Error("Child was deferred");
    const current = composition.persistence.getInstance(record.instanceId)!;
    expect(isTodoState(current.state.todoState)).toBe(true);
    if (!isTodoState(current.state.todoState)) {
      throw new Error("Todo state is absent");
    }
    expect(
      current.state.todoState.lists.flatMap((list) => list.assignments ?? []),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: "sample-model",
          provider: "other-provider",
          sessionKey: spawned.assignment.sessionKey,
        }),
      ]),
    );
    expect(t3.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modelSelection: {
            instanceId: "other-provider",
            model: "sample-model",
          },
          threadId: spawned.assignment.threadId,
          type: "thread.create",
        }),
      ]),
    );
    await composition.close();
  });

  it("fails closed when persisted parent and child session identities collide", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const composition = createProductionComposition({
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
    });
    await composition.start();
    const instanceId = `task-${fixture.taskId}`;
    const current = composition.persistence.getInstance(instanceId)!;
    if (!isTodoState(current.state.todoState)) {
      throw new Error("Todo state is absent");
    }
    const parent = composition.persistence.listSessionRuntime()[0]!;
    const list = current.state.todoState.lists[0]!;
    composition.persistence.updateInstance(instanceId, {
      ...current.state,
      todoState: {
        ...current.state.todoState,
        lists: [
          {
            ...list,
            assignments: [
              {
                bootstrap: {
                  createCommandId: "create-command",
                  createdAt: "2026-01-01T00:00:00.000Z",
                  messageId: "message-id",
                  turnCommandId: "turn-command",
                },
                correlationToken: "child-token",
                depth: 1,
                model: "sample-model",
                operationId: "spawn-collision",
                parentSessionKey: parent.sessionKey,
                parentThreadId: parent.threadId,
                provider: "codex",
                rootItemId: "deliver",
                sessionKey: parent.sessionKey,
                status: "active",
                threadId: "child-thread",
              },
            ],
          },
        ],
      },
    });

    expect(() => productionSessionTargets(composition.persistence)).toThrow(
      "Production session identities are not globally unique",
    );
    await composition.close();
  });
});
