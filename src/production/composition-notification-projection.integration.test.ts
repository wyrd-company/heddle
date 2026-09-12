// ---
// relationships:
//   verifies: heddle
// ---

import { afterEach, describe, expect, it, vi } from "vitest";

import { escalationAttentionId } from "../mcp-server/escalation-contract.js";
import {
  createProductionComposition,
  type ProductionComposition,
} from "./composition.js";
import {
  execute,
  prepareProductionFixture,
  SyntheticT3,
} from "./composition.test-support.js";
import { NotificationDeliveryError } from "./durable-adapters.js";
import {
  notificationDeliveryErrorAttention,
  productionErrorAttention,
} from "./error-visibility.js";

const notificationFailures = (
  composition: ProductionComposition,
  stableId: string,
) =>
  composition.persistence
    .listAttention()
    .filter(
      ({ payload }) =>
        typeof payload === "object" &&
        payload !== null &&
        !Array.isArray(payload) &&
        payload["kind"] === "production-error" &&
        typeof payload["code"] === "string" &&
        payload["code"].startsWith("notification-delivery-") &&
        payload["notificationStableId"] === stableId,
    );

const requestedAttentionId = (
  init: Parameters<typeof globalThis.fetch>[1],
): string | null => {
  const target = new globalThis.URLSearchParams(String(init?.body)).get("url");
  return target === null
    ? null
    : new globalThis.URL(target).searchParams.get("attention");
};

const openEscalation = (
  composition: ProductionComposition,
  runtime: { instanceId: string; sessionKey: string; stageId: string },
  escalationId: string,
  prompt: string,
): string => {
  const attentionId = escalationAttentionId(
    runtime.instanceId,
    runtime.sessionKey,
    escalationId,
  );
  composition.persistence.appendEvent(
    runtime.instanceId,
    "mcp:escalation-opened",
    {
      threadId: "thread-17",
      requestId: "request-one",
      attentionId,
      escalationId,
      instanceId: runtime.instanceId,
      openedAt: "2026-01-01T00:00:00.000Z",
      ownerSessionKey: runtime.sessionKey,
      questions: [
        {
          multiSelect: false,
          id: "selection",
          options: [
            {
              description: "Use the first sample",
              label: "first",
            },
            {
              description: "Use the second sample",
              label: "second",
            },
          ],
          question: prompt,
        },
      ],
      stage: runtime.stageId,
    },
  );
  return attentionId;
};

describe("production notification failure projection", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
  });

  it("projects only the current delivery failure when a retry becomes permanently rejected", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    let now = 10_000;
    let targetId = "";
    let targetAttempt = 0;
    const fetch = vi.fn(
      async (
        _input: unknown,
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        if (requestedAttentionId(init) !== targetId) {
          return new globalThis.Response(JSON.stringify({ status: 1 }), {
            status: 200,
          });
        }
        targetAttempt += 1;
        if (targetAttempt === 1) {
          return new globalThis.Response(JSON.stringify({ status: 0 }), {
            status: 503,
          });
        }
        return targetAttempt === 2
          ? new globalThis.Response(
              JSON.stringify({
                errors: ["private detail"],
                status: 0,
                token: "x",
              }),
              { status: 400 },
            )
          : new globalThis.Response(JSON.stringify({ status: 0 }), {
              status: 503,
            });
      },
    );
    const t3 = new SyntheticT3();
    const createComposition = () =>
      createProductionComposition({
        workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
        blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
        configuration: fixture.configuration,
        providerUsage: {
          readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
        },
        notificationNow: () => now,
        pushoverFetch: fetch,
        t3,
      });
    const first = createComposition();
    await first.start();
    const runtime = first.persistence.listReconcilerRuntime()[0]!;
    const targetPrompt = "Which sample should be selected?";
    targetId = openEscalation(
      first,
      {
        instanceId: runtime.instanceId,
        sessionKey: runtime.sessionKey!,
        stageId: runtime.stageId!,
      },
      "primary-choice",
      targetPrompt,
    );
    const laterId = openEscalation(
      first,
      {
        instanceId: runtime.instanceId,
        sessionKey: runtime.sessionKey!,
        stageId: runtime.stageId!,
      },
      "secondary-choice",
      "Which alternate sample should be selected?",
    );
    const created = await execute(
      "kanban-md",
      [
        "--dir",
        fixture.configuration.boardDirectory,
        "create",
        "Independent Item",
        "--status",
        "todo",
        "--tags",
        "lifecycle:sample",
        "--json",
      ],
      { cwd: fixture.root },
    );
    const independentTaskId = (JSON.parse(created.stdout) as { id: number }).id;

    await first.scheduler.trigger();
    expect(
      fetch.mock.calls.filter(
        ([, init]) => requestedAttentionId(init) === targetId,
      ),
    ).toHaveLength(1);
    expect(notificationFailures(first, targetId)).toMatchObject([
      { payload: { code: "notification-delivery-retryable" } },
    ]);
    expect(first.persistence.effectCompleted("pushover", laterId)).toBe(true);
    expect(
      first.persistence
        .listReconcilerRuntime()
        .find(({ taskId }) => taskId === independentTaskId),
    ).toMatchObject({ state: "waiting" });

    const neighboringStableId = "sample-neighbor-notification";
    await first.attention.raise(
      notificationDeliveryErrorAttention({
        error: new NotificationDeliveryError("retryable", "network-failure"),
        instanceId: runtime.instanceId,
        stableId: neighboringStableId,
        taskId: fixture.taskId,
      }),
    );
    const unrelated = {
      ...productionErrorAttention({
        code: "task-reconciliation-failed",
        error: new Error("Synthetic failure"),
        instanceId: runtime.instanceId,
        summary: "Sample source failed",
        taskId: fixture.taskId,
      }),
      notificationStableId: targetId,
    };
    await first.attention.raise(unrelated);

    now = 15_000;
    await first.scheduler.trigger();
    expect(
      fetch.mock.calls.filter(
        ([, init]) => requestedAttentionId(init) === targetId,
      ),
    ).toHaveLength(2);
    const targetFailures = notificationFailures(first, targetId);
    expect(targetFailures).toMatchObject([
      {
        payload: {
          code: "notification-delivery-rejected",
          notificationOccurrence: 1,
          notificationStableId: targetId,
        },
      },
    ]);
    const rejection = first.attention
      .list()
      .find(
        ({ attentionId }) => attentionId === targetFailures[0]?.attentionId,
      );
    expect(rejection).toMatchObject({
      actions: [
        {
          actionId: "notification.retry",
          contract: { kind: "notification.retry", occurrence: 1 },
        },
        expect.objectContaining({ actionId: "attention.resolve" }),
      ],
      notificationVerification: {
        message: `Heddle escalation in ${runtime.stageId}`,
        recipientLabel: "Primary operator",
      },
    });
    expect(JSON.stringify(rejection)).not.toContain(targetId);
    expect(notificationFailures(first, neighboringStableId)).toHaveLength(1);
    expect(first.persistence.listAttention()).toContainEqual(
      expect.objectContaining({ attentionId: unrelated.attentionId }),
    );
    expect(
      first.escalation.pendingEscalations(runtime.instanceId),
    ).toContainEqual(
      expect.objectContaining({
        attentionId: targetId,
        questions: [expect.objectContaining({ question: targetPrompt })],
      }),
    );
    expect(first.attention.list()).toContainEqual(
      expect.objectContaining({
        actions: [expect.objectContaining({ actionId: "escalation.answer" })],
        attentionId: targetId,
        message: targetPrompt,
      }),
    );

    await first.scheduler.trigger();
    expect(
      fetch.mock.calls.filter(
        ([, init]) => requestedAttentionId(init) === targetId,
      ),
    ).toHaveLength(2);
    await first.close();

    const restarted = createComposition();
    await restarted.start();
    expect(
      fetch.mock.calls.filter(
        ([, init]) => requestedAttentionId(init) === targetId,
      ),
    ).toHaveLength(2);
    expect(notificationFailures(restarted, targetId)).toMatchObject([
      {
        payload: {
          code: "notification-delivery-rejected",
          notificationOccurrence: 1,
        },
      },
    ]);
    expect(notificationFailures(restarted, neighboringStableId)).toHaveLength(
      1,
    );
    expect(restarted.persistence.listAttention()).toContainEqual(
      expect.objectContaining({ attentionId: unrelated.attentionId }),
    );
    expect(restarted.persistence.effectCompleted("pushover", targetId)).toBe(
      false,
    );
    expect(restarted.persistence.effectCompleted("pushover", laterId)).toBe(
      true,
    );
    expect(
      restarted.escalation.pendingEscalations(runtime.instanceId),
    ).toContainEqual(
      expect.objectContaining({
        attentionId: targetId,
        questions: [expect.objectContaining({ question: targetPrompt })],
      }),
    );
    await restarted.close();

    const afterAction = createComposition();
    await afterAction.start();
    const currentRejection = afterAction.attention
      .list()
      .find(({ actions }) => actions[0]?.actionId === "notification.retry");
    if (currentRejection === undefined) {
      throw new Error("Missing current notification rejection");
    }
    await afterAction.consoleActions.execute({
      action: currentRejection.actions[0]!,
      attention: currentRejection,
    });
    await afterAction.scheduler.trigger();
    expect(
      fetch.mock.calls.filter(
        ([, init]) => requestedAttentionId(init) === targetId,
      ),
    ).toHaveLength(3);
    expect(notificationFailures(afterAction, targetId)).toMatchObject([
      { payload: { code: "notification-delivery-retryable" } },
    ]);
    expect(
      afterAction.persistence.effectCompleted(
        "console-attention-action",
        currentRejection.attentionId,
      ),
    ).toBe(true);
    await afterAction.close();

    const afterActionRestart = createComposition();
    await afterActionRestart.start();
    expect(
      fetch.mock.calls.filter(
        ([, init]) => requestedAttentionId(init) === targetId,
      ),
    ).toHaveLength(3);
    expect(notificationFailures(afterActionRestart, targetId)).toMatchObject([
      { payload: { code: "notification-delivery-retryable" } },
    ]);
    expect(
      afterActionRestart.escalation.pendingEscalations(runtime.instanceId),
    ).toContainEqual(
      expect.objectContaining({
        attentionId: targetId,
        questions: [expect.objectContaining({ question: targetPrompt })],
      }),
    );
    await afterActionRestart.close();
  }, 10_000);

  it("projects a changed retryable category without stopping later routes or reconciliation", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    let now = 10_000;
    let targetId = "";
    let targetAttempt = 0;
    const fetch = vi.fn(
      async (
        _input: unknown,
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        if (requestedAttentionId(init) !== targetId) {
          return new globalThis.Response(JSON.stringify({ status: 1 }), {
            status: 200,
          });
        }
        targetAttempt += 1;
        if (targetAttempt === 1) {
          return new globalThis.Response(JSON.stringify({ status: 0 }), {
            status: 503,
          });
        }
        throw new Error("Synthetic network failure");
      },
    );
    const t3 = new SyntheticT3();
    const createComposition = () =>
      createProductionComposition({
        workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
        blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
        configuration: fixture.configuration,
        providerUsage: {
          readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
        },
        notificationNow: () => now,
        pushoverFetch: fetch,
        t3,
      });
    const first = createComposition();
    await first.start();
    const runtime = first.persistence.listReconcilerRuntime()[0]!;
    if (runtime.sessionKey === undefined || runtime.stageId === undefined) {
      throw new Error("Missing sample runtime session");
    }
    const escalationRuntime = {
      instanceId: runtime.instanceId,
      sessionKey: runtime.sessionKey,
      stageId: runtime.stageId,
    };
    const targetPrompt = "Which sample should be retained?";
    targetId = openEscalation(
      first,
      escalationRuntime,
      "category-change",
      targetPrompt,
    );
    const completedRouteId = openEscalation(
      first,
      escalationRuntime,
      "completed-route",
      "Which completed-route sample should be retained?",
    );

    await first.scheduler.trigger();
    expect(
      fetch.mock.calls.filter(
        ([, init]) => requestedAttentionId(init) === targetId,
      ),
    ).toHaveLength(1);
    const initialTargetFailures = notificationFailures(first, targetId);
    expect(initialTargetFailures).toMatchObject([
      {
        payload: {
          code: "notification-delivery-retryable",
          notificationCategory: "provider-unavailable",
        },
      },
    ]);
    const initialFailureId = initialTargetFailures[0]!.attentionId;
    expect(
      first.persistence.effectCompleted("pushover", completedRouteId),
    ).toBe(true);

    const laterRouteId = openEscalation(
      first,
      escalationRuntime,
      "later-route",
      "Which later-route sample should be retained?",
    );
    const created = await execute(
      "kanban-md",
      [
        "--dir",
        fixture.configuration.boardDirectory,
        "create",
        "Later Independent Item",
        "--status",
        "todo",
        "--tags",
        "lifecycle:sample",
        "--json",
      ],
      { cwd: fixture.root },
    );
    const independentTaskId = (JSON.parse(created.stdout) as { id: number }).id;

    now = 15_000;
    await first.scheduler.trigger();
    expect(
      fetch.mock.calls.filter(
        ([, init]) => requestedAttentionId(init) === targetId,
      ),
    ).toHaveLength(2);
    const changedTargetFailures = notificationFailures(first, targetId);
    expect(changedTargetFailures).toMatchObject([
      {
        payload: {
          code: "notification-delivery-retryable",
          notificationCategory: "network-failure",
        },
      },
    ]);
    expect(changedTargetFailures[0]!.attentionId).not.toBe(initialFailureId);
    expect(first.persistence.hasAttention(initialFailureId)).toBe(true);
    expect(first.persistence.effectCompleted("pushover", laterRouteId)).toBe(
      true,
    );
    expect(
      first.persistence
        .listReconcilerRuntime()
        .find(({ taskId }) => taskId === independentTaskId),
    ).toMatchObject({ state: "waiting" });
    expect(
      first.escalation.pendingEscalations(runtime.instanceId),
    ).toContainEqual(
      expect.objectContaining({
        attentionId: targetId,
        questions: [expect.objectContaining({ question: targetPrompt })],
      }),
    );
    await first.close();

    const restarted = createComposition();
    await restarted.start();
    expect(
      fetch.mock.calls.filter(
        ([, init]) => requestedAttentionId(init) === targetId,
      ),
    ).toHaveLength(2);
    expect(notificationFailures(restarted, targetId)).toMatchObject([
      {
        payload: {
          code: "notification-delivery-retryable",
          notificationCategory: "network-failure",
        },
      },
    ]);
    expect(
      restarted.persistence.effectCompleted("pushover", laterRouteId),
    ).toBe(true);
    expect(
      restarted.escalation.pendingEscalations(runtime.instanceId),
    ).toContainEqual(
      expect.objectContaining({
        attentionId: targetId,
        questions: [expect.objectContaining({ question: targetPrompt })],
      }),
    );
    await restarted.close();
  });
});
