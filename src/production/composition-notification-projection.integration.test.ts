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

describe("production notification failure projection", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
  });

  it("projects only the current delivery failure when a retry becomes permanently rejected", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    let now = 10_000;
    let attempt = 0;
    const fetch = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        return new globalThis.Response(JSON.stringify({ status: 0 }), {
          status: 503,
        });
      }
      if (attempt === 2) {
        return new globalThis.Response(JSON.stringify({ status: 1 }), {
          status: 200,
        });
      }
      return attempt === 3
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
    });
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
    const openEscalation = (escalationId: string, prompt: string) => {
      const attentionId = escalationAttentionId(
        runtime.instanceId,
        runtime.sessionKey!,
        escalationId,
      );
      first.persistence.appendEvent(
        runtime.instanceId,
        "mcp:escalation-opened",
        {
          attentionId,
          escalationId,
          instanceId: runtime.instanceId,
          openedAt: "2026-01-01T00:00:00.000Z",
          ownerSessionKey: runtime.sessionKey!,
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
              prompt,
            },
          ],
          stage: runtime.stageId!,
        },
      );
      return attentionId;
    };
    const targetPrompt = "Which sample should be selected?";
    const targetId = openEscalation("primary-choice", targetPrompt);
    const laterId = openEscalation(
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
    expect(fetch).toHaveBeenCalledTimes(2);
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
        code: "sample-source-failed",
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
    expect(fetch).toHaveBeenCalledTimes(3);
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
          contract: { occurrence: 1, stableId: targetId },
        },
      ],
    });
    expect(notificationFailures(first, neighboringStableId)).toHaveLength(1);
    expect(first.persistence.listAttention()).toContainEqual(
      expect.objectContaining({ attentionId: unrelated.attentionId }),
    );
    expect(
      first.escalation.pendingEscalations(runtime.instanceId),
    ).toContainEqual(
      expect.objectContaining({
        attentionId: targetId,
        questions: [expect.objectContaining({ prompt: targetPrompt })],
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
    expect(fetch).toHaveBeenCalledTimes(3);
    await first.close();

    const restarted = createComposition();
    await restarted.start();
    expect(fetch).toHaveBeenCalledTimes(3);
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
        questions: [expect.objectContaining({ prompt: targetPrompt })],
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
    expect(fetch).toHaveBeenCalledTimes(4);
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
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(notificationFailures(afterActionRestart, targetId)).toMatchObject([
      { payload: { code: "notification-delivery-retryable" } },
    ]);
    expect(
      afterActionRestart.escalation.pendingEscalations(runtime.instanceId),
    ).toContainEqual(
      expect.objectContaining({
        attentionId: targetId,
        questions: [expect.objectContaining({ prompt: targetPrompt })],
      }),
    );
    await afterActionRestart.close();
  });
});
