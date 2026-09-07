// ---
// relationships:
//   verifies: heddle
// ---

import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkflowMcpSessionResolver } from "../mcp-server/index.js";
import { escalationAttentionId } from "../mcp-server/escalation-contract.js";
import type { JsonValue } from "../persistence/index.js";
import { resolvedSessionBindingFixture } from "../persistence/resolved-session-binding.test-support.js";
import { isTodoState } from "../todo/index.js";
import { createProductionComposition } from "./composition.js";
import {
  prepareProductionEpicFixture,
  prepareProductionFixture,
  SyntheticT3,
} from "./composition.test-support.js";
import { productionSessionTargets } from "./subagent-composition.js";
import type { SpawnSubagentResult } from "../subagents/index.js";

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

const callMcpTool = async (
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
    result?: {
      content?: Array<{ text?: string }>;
      isError?: boolean;
      structuredContent?: unknown;
    };
  };
};

describe("production subagent composition", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
  });

  it("shares organization template authority, persistence, pacing, observation, and tokens", async () => {
    const fixture = await prepareProductionEpicFixture();
    cleanup = fixture.cleanup;
    fixture.configuration.session.resolvedSelections = [
      ...fixture.configuration.session.resolvedSelections,
      {
        ...fixture.configuration.session.defaultSelection,
        alias: "child-selection",
        model: {
          isCustom: false,
          name: "Sample Child Model",
          slug: "sample-child-model",
        },
      },
      {
        ...fixture.configuration.session.defaultSelection,
        alias: "grandchild-selection",
        model: {
          isCustom: false,
          name: "Sample Grandchild Model",
          slug: "sample-grandchild-model",
        },
      },
    ];
    fixture.configuration.providerAliases["child-selection"] = {
      model: "sample-child-model",
      providerDisplayName: "Workbench Alpha",
    };
    fixture.configuration.providerAliases["grandchild-selection"] = {
      model: "sample-grandchild-model",
      providerDisplayName: "Workbench Alpha",
    };
    fixture.configuration.pacing.providerBudgets = {
      codex: { usageLimit: 100 },
    };
    const t3 = new SyntheticT3();
    t3.providerCatalog[0]!.models.push(
      {
        isCustom: false,
        name: "Sample Child Model",
        slug: "sample-child-model",
      },
      {
        isCustom: false,
        name: "Sample Grandchild Model",
        slug: "sample-grandchild-model",
      },
    );
    const systemPrompt = "# Operator session guidance";
    const resolveSystemPrompt = vi.fn(async () => systemPrompt);
    const readProviderUsage = vi.fn(async () => ({
      used: 0,
      windowStartedAt: 0,
    }));
    const composition = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: readProviderUsage,
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      resolveSystemPrompt,
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
      expect.arrayContaining(["list_providers", "liveness", "spawn"]),
    );
    const listed = await callMcpTool(
      composition,
      parent.token,
      "list_providers",
      {},
    );
    expect(listed.result?.structuredContent).toMatchObject({
      aliases: [
        expect.objectContaining({ alias: "child-selection", selectable: true }),
        expect.objectContaining({
          alias: "grandchild-selection",
          selectable: true,
        }),
        expect.objectContaining({ alias: "primary", selectable: true }),
      ],
      version: 1,
    });
    expect(JSON.stringify(listed)).not.toContain("providerInstanceId");
    const parentRuntime = composition.persistence
      .listSessionRuntime()
      .find(({ sessionKey }) => sessionKey === parent.sessionKey)!;

    const spawnResponse = await callMcpTool(
      composition,
      parent.token,
      "spawn",
      {
        operationId: "spawn-child-one",
        providerAlias: "child-selection",
        rootItemId: "deliver",
      },
    );
    expect(spawnResponse.result?.isError).not.toBe(true);
    const spawned = spawnResponse.result
      ?.structuredContent as SpawnSubagentResult;
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
    expect(readProviderUsage.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(
      readProviderUsage.mock.calls.every(([provider]) => provider === "codex"),
    ).toBe(true);
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
    const epicProjectId = t3.commands.find(
      ({ type }) => type === "project.create",
    )?.projectId;
    expect(childCreate).toMatchObject({
      branch: `heddle/task-${fixture.taskId}`,
      projectId: epicProjectId,
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
    const parentTurn = t3.commands.find(
      (command) =>
        command.type === "thread.turn.start" &&
        command.threadId === parentRuntime.threadId,
    );
    for (const turn of [parentTurn, childTurn]) {
      expect(
        (turn?.["message"] as { text: string }).text.startsWith(
          `${systemPrompt}\n\n`,
        ),
      ).toBe(true);
    }
    expect(resolveSystemPrompt).toHaveBeenCalledTimes(2);

    const originalChildCommands = t3.commands.filter(
      ({ threadId }) => threadId === spawned.assignment.threadId,
    );
    t3.providerCatalog.splice(0);
    fixture.configuration.session.resolvedSelections = [];
    fixture.configuration.session.defaultSelection = {
      ...fixture.configuration.session.defaultSelection,
      driverKind: "claudeAgent",
      providerInstanceId: "changed-provider",
    };
    await expect(
      composition.subagents.spawn(parent, {
        operationId: "spawn-child-one",
        providerAlias: "child-selection",
        rootItemId: "deliver",
      }),
    ).resolves.toMatchObject({
      assignment: { binding: spawned.assignment.binding },
      kind: "spawned",
    });
    expect(
      t3.commands
        .filter(({ threadId }) => threadId === spawned.assignment.threadId)
        .slice(-2),
    ).toEqual(originalChildCommands);
    expect(t3.providerContexts.slice(-2)).toEqual([
      expect.objectContaining({
        driver: "codex",
        providerInstanceId: "codex",
      }),
      expect.objectContaining({
        driver: "codex",
        providerInstanceId: "codex",
      }),
    ]);

    await expect(
      composition.subagents.spawn(parent, {
        operationId: "spawn-child-two",
        providerAlias: "child-selection",
        rootItemId: "deliver",
      }),
    ).resolves.toMatchObject({
      deferral: { reason: "subagent-fan-out-limit" },
      kind: "deferred",
    });
    await expect(
      composition.subagents.spawn(child, {
        operationId: "spawn-grandchild",
        providerAlias: "grandchild-selection",
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
    fixture.configuration.providerAliases.secondary = {
      model: "sample-model",
      providerDisplayName: "Workbench Beta",
    };
    fixture.configuration.session.resolvedSelections = [
      ...fixture.configuration.session.resolvedSelections,
      {
        alias: "secondary",
        driverKind: "codex",
        interactionMode: "default",
        model: {
          isCustom: false,
          name: "Sample Model",
          slug: "sample-model",
        },
        observedCliVersion: "catalog-version-secondary",
        providerDisplayName: "Workbench Beta",
        providerInstanceId: "provider-beta",
        runtimeMode: "auto-accept-edits",
      },
    ];
    fixture.configuration.pacing.providerBudgets = {
      "provider-beta": { usageLimit: 100 },
    };
    const readProviderUsage = vi.fn(async () => ({
      used: 0,
      windowStartedAt: 0,
    }));
    const t3 = new SyntheticT3();
    t3.providerCatalog.push({
      availability: "available",
      displayName: "Workbench Beta",
      driverKind: "codex",
      enabled: true,
      installed: true,
      instanceId: "provider-beta",
      models: [
        {
          isCustom: false,
          name: "Sample Model",
          slug: "sample-model",
        },
      ],
      observedCliVersion: "catalog-version-secondary",
      state: "ready",
    });
    const composition = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: readProviderUsage,
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
    const parentRuntime = composition.persistence
      .listSessionRuntime()
      .find(({ sessionKey }) => sessionKey === parent.sessionKey)!;

    const spawned = await composition.subagents.spawn(parent, {
      operationId: "delegated-provider",
      providerAlias: "secondary",
      rootItemId: "deliver",
      runtimeMode: "full-access",
    });
    expect(spawned).toMatchObject({
      assignment: {
        binding: {
          alias: "secondary",
          driverKind: "codex",
          interactionMode: "default",
          modelSlug: "sample-model",
          observedCliVersion: "catalog-version-secondary",
          providerDisplayName: "Workbench Beta",
          providerInstanceId: "provider-beta",
          runtimeMode: "full-access",
          sessionKey: expect.any(String),
          threadId: expect.any(String),
        },
        model: "sample-model",
        provider: "provider-beta",
      },
      kind: "spawned",
    });
    if (spawned.kind !== "spawned") throw new Error("Child was deferred");
    expect(readProviderUsage).toHaveBeenCalledWith("provider-beta");
    expect(readProviderUsage).not.toHaveBeenCalledWith("secondary");
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
          provider: "provider-beta",
          sessionKey: spawned.assignment.sessionKey,
        }),
      ]),
    );
    expect(t3.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modelSelection: {
            instanceId: "provider-beta",
            model: "sample-model",
          },
          threadId: spawned.assignment.threadId,
          type: "thread.create",
        }),
        expect.objectContaining({
          runtimeMode: "full-access",
          threadId: spawned.assignment.threadId,
          type: "thread.turn.start",
        }),
      ]),
    );
    expect(t3.timeouts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          driver: "codex",
          providerInstanceId: "provider-beta",
          threadId: spawned.assignment.threadId,
        }),
      ]),
    );
    expect(t3.providerContexts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cliVersion: "catalog-version-secondary",
          driver: "codex",
          providerInstanceId: "provider-beta",
        }),
      ]),
    );

    const operatorProjection = await composition.consoleState.listInstances();
    expect(operatorProjection).toEqual([
      expect.objectContaining({
        instanceId: record.instanceId,
        sessionBindings: expect.arrayContaining([
          expect.objectContaining({
            alias: "primary",
            providerInstanceId: "codex",
            sessionKey: parentRuntime.sessionKey,
          }),
          expect.objectContaining({
            alias: "secondary",
            providerInstanceId: "provider-beta",
            sessionKey: spawned.assignment.sessionKey,
          }),
        ]),
      }),
    ]);
    expect(JSON.stringify(operatorProjection)).not.toContain("access-token");

    fixture.configuration.session.defaultSelection = {
      ...fixture.configuration.session.defaultSelection,
      driverKind: "claudeAgent",
      providerInstanceId: "changed-provider",
    };

    t3.threads.delete(spawned.assignment.threadId);
    await composition.scheduler.trigger();

    const parentContinuation = t3.dispatches
      .filter(
        ({ command }) =>
          command.type === "thread.turn.start" &&
          command.threadId === parentRuntime.threadId,
      )
      .at(-1);
    expect(parentContinuation).toMatchObject({
      command: {
        runtimeMode: "auto-accept-edits",
        threadId: parentRuntime.threadId,
        type: "thread.turn.start",
      },
      providerContext: {
        cliVersion: "0.91.0",
        driver: "codex",
        lifecycle: "independent",
        providerInstanceId: "codex",
      },
    });
    await composition.close();
  });

  it("rechecks listed aliases at spawn and contains forbidden selections before effects", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    fixture.configuration.providerAliases.secondary = {
      model: "model-beta",
      providerDisplayName: "Workbench Beta",
    };
    fixture.configuration.session.resolvedSelections.push({
      alias: "secondary",
      driverKind: "sample-driver",
      interactionMode: "default",
      model: {
        isCustom: false,
        name: "Model Beta",
        slug: "model-beta",
      },
      observedCliVersion: "2.0.0",
      providerDisplayName: "Workbench Beta",
      providerInstanceId: "provider-beta",
      runtimeMode: "auto-accept-edits",
    });
    const t3 = new SyntheticT3();
    t3.providerCatalog.push({
      availability: "available",
      displayName: "Workbench Beta",
      driverKind: "sample-driver",
      enabled: true,
      installed: true,
      instanceId: "provider-beta",
      models: [
        {
          isCustom: false,
          name: "Model Beta",
          slug: "model-beta",
        },
      ],
      observedCliVersion: "2.0.0",
      state: "ready",
    });
    const readProviderUsage = vi.fn(async () => ({
      used: 0,
      windowStartedAt: 0,
    }));
    const composition = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: { readFiveHourWindow: readProviderUsage },
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

    const listed = await callMcpTool(
      composition,
      parent.token,
      "list_providers",
      {},
    );
    expect(listed.result?.structuredContent).toMatchObject({
      aliases: expect.arrayContaining([
        expect.objectContaining({ alias: "secondary", selectable: true }),
      ]),
    });
    const effectsBefore = {
      commands: t3.commands.length,
      mcpRegistrations: t3.mcpRegistrations.length,
      timeouts: t3.timeouts.length,
      usageReads: readProviderUsage.mock.calls.length,
    };
    t3.providerCatalog.find(
      ({ instanceId }) => instanceId === "provider-beta",
    )!.enabled = false;

    for (const [providerAlias, reason] of [
      ["secondary", "provider-unavailable"],
      ["unknown", "provider-alias-not-allowed"],
    ] as const) {
      const rejected = await callMcpTool(composition, parent.token, "spawn", {
        operationId: `reject-${providerAlias}`,
        providerAlias,
        rootItemId: "deliver",
      });
      expect(rejected.result?.isError).toBe(true);
      expect(rejected.result?.structuredContent).toMatchObject({
        error: { reason },
      });
    }
    const rawSelection = await callMcpTool(composition, parent.token, "spawn", {
      model: "model-beta",
      operationId: "reject-raw-selection",
      provider: "provider-beta",
      rootItemId: "deliver",
    });
    expect(rawSelection.result?.isError).toBe(true);
    const catalogFailure = vi
      .spyOn(t3, "readProviderCatalog")
      .mockRejectedValueOnce(new Error("credential-shaped transport detail"));
    const failedListing = await callMcpTool(
      composition,
      parent.token,
      "list_providers",
      {},
    );
    expect(failedListing.result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          message: "T3 provider catalog is unavailable",
          reason: "provider-catalog-unavailable",
        },
      },
    });
    expect(JSON.stringify(failedListing)).not.toContain(
      "credential-shaped transport detail",
    );
    expect(catalogFailure).toHaveBeenCalledTimes(1);
    const current = composition.persistence.getInstance(record.instanceId)!;
    expect(isTodoState(current.state.todoState)).toBe(true);
    if (!isTodoState(current.state.todoState)) {
      throw new Error("Todo state is absent");
    }
    expect(
      current.state.todoState.lists.flatMap((list) => list.assignments ?? []),
    ).toEqual([]);
    expect({
      commands: t3.commands.length,
      mcpRegistrations: t3.mcpRegistrations.length,
      timeouts: t3.timeouts.length,
      usageReads: readProviderUsage.mock.calls.length,
    }).toEqual(effectsBefore);
    await composition.close();
  });

  it("routes a pending child escalation after restart through the durable parent binding", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    fixture.configuration.providerAliases.secondary = {
      model: "model-secondary",
      providerDisplayName: "Workbench Beta",
    };
    fixture.configuration.session.resolvedSelections = [
      ...fixture.configuration.session.resolvedSelections,
      {
        alias: "secondary",
        driverKind: "cursor",
        interactionMode: "review",
        model: {
          isCustom: false,
          name: "Model Secondary",
          slug: "model-secondary",
        },
        observedCliVersion: "2.0.0",
        providerDisplayName: "Workbench Beta",
        providerInstanceId: "provider-beta",
        runtimeMode: "full-access",
      },
    ];
    const firstT3 = new SyntheticT3();
    firstT3.providerCatalog.push({
      availability: "available",
      displayName: "Workbench Beta",
      driverKind: "cursor",
      enabled: true,
      installed: true,
      instanceId: "provider-beta",
      models: [
        {
          isCustom: false,
          name: "Model Secondary",
          slug: "model-secondary",
        },
      ],
      observedCliVersion: "2.0.0",
      state: "ready",
    });
    const first = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: firstT3,
    });
    await first.start();
    const instanceId = `task-${fixture.taskId}`;
    const record = first.persistence.getInstance(instanceId)!;
    const resolver = new WorkflowMcpSessionResolver(first.persistence);
    const parent = await resolver.resolve(
      storedCorrelationToken(record.state.handoffs),
    );
    const parentBinding = first.persistence
      .listSessionRuntime()
      .find(({ sessionKey }) => sessionKey === parent.sessionKey)!.binding;
    const spawned = await first.subagents.spawn(parent, {
      operationId: "spawn-escalating-child",
      providerAlias: "secondary",
      rootItemId: "deliver",
    });
    if (spawned.kind !== "spawned") throw new Error("Child was deferred");
    const child = await resolver.resolve(spawned.assignment.correlationToken);
    const escalationId = "pending-child-choice";
    const attentionId = escalationAttentionId(
      instanceId,
      child.sessionKey,
      escalationId,
    );
    first.persistence.appendEvent(instanceId, "mcp:escalation-opened", {
      attentionId,
      escalationId,
      instanceId,
      openedAt: "2026-01-01T00:00:00.000Z",
      ownerSessionKey: child.sessionKey,
      parentSessionKey: parent.sessionKey,
      questions: [
        {
          id: "selection",
          options: [
            {
              description: "Use the first sample",
              id: "first",
              label: "First",
            },
            {
              description: "Use the second sample",
              id: "second",
              label: "Second",
            },
          ],
          prompt: "Which sample should be selected?",
        },
      ],
      stage: child.stage.id,
    });
    await first.close();

    fixture.configuration.pacing.defaultProvider = "provider-changed";
    fixture.configuration.providerAliases = {
      changed: {
        model: "model-changed",
        providerDisplayName: "Workbench Changed",
      },
    };
    fixture.configuration.session.defaultProviderAlias = "changed";
    fixture.configuration.session.defaultRuntimeMode = "approval-required";
    fixture.configuration.session.interactionMode = "alternate";
    fixture.configuration.session.defaultSelection = {
      alias: "changed",
      driverKind: "claudeAgent",
      interactionMode: "alternate",
      model: {
        isCustom: true,
        name: "Model Changed",
        slug: "model-changed",
      },
      observedCliVersion: "9.9.9",
      providerDisplayName: "Workbench Changed",
      providerInstanceId: "provider-changed",
      runtimeMode: "approval-required",
    };
    fixture.configuration.session.resolvedSelections = [
      fixture.configuration.session.defaultSelection,
    ];
    const restartedT3 = new SyntheticT3();
    const restarted = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: restartedT3,
    });

    await restarted.start();

    const escalationDispatches = restartedT3.dispatches.filter(
      ({ command }) =>
        command.type === "thread.turn.start" &&
        command.message.text ===
          `Child escalation ${attentionId} requires an answer`,
    );
    expect(escalationDispatches).toEqual([
      {
        command: expect.objectContaining({
          interactionMode: parentBinding.interactionMode,
          runtimeMode: parentBinding.runtimeMode,
          threadId: parentBinding.threadId,
          type: "thread.turn.start",
        }),
        providerContext: {
          cliVersion: parentBinding.observedCliVersion,
          driver: parentBinding.driverKind,
          lifecycle: "independent",
          providerInstanceId: parentBinding.providerInstanceId,
        },
      },
    ]);
    await restarted.close();
  });

  it("fails closed when persisted parent and child session identities collide", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const composition = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
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
                binding: resolvedSessionBindingFixture({
                  alias: "primary",
                  driverKind: "codex",
                  modelSlug: "sample-model",
                  providerDisplayName: "Workbench Alpha",
                  providerInstanceId: "codex",
                  runtimeMode: "auto-accept-edits",
                  sessionKey: parent.sessionKey,
                  threadId: "child-thread",
                }),
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
