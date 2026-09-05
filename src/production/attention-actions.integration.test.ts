// ---
// relationships:
//   verifies: heddle
// ---

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createConsoleAttention,
  MAXIMUM_CONSOLE_ATTENTION_IDENTIFIER_LENGTH,
} from "../console/index.js";
import type { WorkflowMcpSessionBinding } from "../mcp-server/index.js";
import { createProductionComposition } from "./composition.js";
import { NotificationDeliveryError } from "./durable-adapters.js";
import { notificationDeliveryErrorAttention } from "./error-visibility.js";
import {
  prepareProductionFixture,
  SyntheticT3,
} from "./composition.test-support.js";

const providerUsage = {
  readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
};

class FailingApprovalT3 extends SyntheticT3 {
  fail = true;

  override async respondToApproval(
    threadId: string,
    requestId: string,
    decision: "accept" | "reject",
    commandId?: string,
  ) {
    if (this.fail) throw new Error("Injected approval failure");
    return super.respondToApproval(threadId, requestId, decision, commandId);
  }
}

describe("production attention actions", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
  });

  it("does not let a stale notification retry action authorize a newer rejection", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const composition = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage,
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
    });
    await composition.start();
    const stableId = "task-sample:session:notification";
    composition.persistence.recordNotificationFailure(
      stableId,
      "request-rejected",
    );
    composition.persistence.authorizeNotificationRetry(stableId, 1);
    composition.persistence.recordNotificationFailure(
      stableId,
      "request-rejected",
    );
    const runtime = composition.persistence.listReconcilerRuntime()[0]!;
    await composition.attention.raise(
      notificationDeliveryErrorAttention({
        error: new NotificationDeliveryError(
          "permanent",
          "request-rejected",
          1,
        ),
        instanceId: runtime.instanceId,
        stableId,
        taskId: fixture.taskId,
      }),
    );
    const attention = composition.attention
      .list()
      .find(({ actions }) => actions[0]?.actionId === "notification.retry")!;

    await composition.consoleActions.execute({
      action: attention.actions[0]!,
      attention,
    });
    expect(composition.persistence.notificationFailure(stableId)).toMatchObject(
      { occurrence: 2, state: "rejected" },
    );
    expect(
      composition.persistence.effectCompleted(
        "console-attention-action",
        attention.attentionId,
      ),
    ).toBe(true);
    await composition.close();
  });

  it("answers a maximum-length escalation through durable attention", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const composition = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage,
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
    });
    await composition.start();
    const runtime = composition.persistence.listReconcilerRuntime()[0]!;
    const instance = composition.persistence.getInstance(runtime.instanceId)!;
    const binding: WorkflowMcpSessionBinding = {
      dispositions: [],
      instance,
      sessionKey: runtime.sessionKey!,
      stage: { id: runtime.stageId!, tools: ["escalate", "answer"] },
      taskContext: { id: fixture.taskId, title: "Example Item" },
      token: "correlation-token",
    };
    const escalationId = "e".repeat(128);
    const pending = composition.escalation.escalate(binding, {
      escalationId,
      questions: [
        {
          id: "decision",
          options: [
            { description: "Use route A", id: "a", label: "Route A" },
            { description: "Use route B", id: "b", label: "Route B" },
          ],
          prompt: "Choose a route",
        },
      ],
    });
    void pending.catch(() => undefined);
    await vi.waitFor(() =>
      expect(composition.attention.list()).toHaveLength(1),
    );
    const attention = composition.attention.list()[0]!;
    expect(attention.attentionId).toHaveLength(75);
    expect(attention.attentionId.length).toBeLessThanOrEqual(
      MAXIMUM_CONSOLE_ATTENTION_IDENTIFIER_LENGTH,
    );
    await expect(
      composition.consoleActions.execute({
        action: attention.actions[0]!,
        answers: {},
        attention,
      }),
    ).rejects.toThrow("Answers must name every offered question exactly once");
    expect(
      composition.persistence.effectIntentRecorded(
        "console-attention-action",
        attention.attentionId,
      ),
    ).toBe(false);

    await composition.consoleActions.execute({
      action: attention.actions[0]!,
      answers: { decision: "b" },
      attention,
    });

    await expect(pending).resolves.toEqual({
      answers: { decision: "b" },
      escalationId,
    });
    expect(composition.attention.list()).toEqual([]);
    expect(
      composition.persistence.effectCompleted(
        "console-attention-action",
        attention.attentionId,
      ),
    ).toBe(true);
    await composition.close();
  });

  it("retains an overlength raw pending identity for explicit repair", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const composition = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage,
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
    });
    await composition.start();
    const runtime = composition.persistence.listReconcilerRuntime()[0]!;
    const escalationId = "e".repeat(128);
    const attentionId = JSON.stringify([
      runtime.instanceId,
      runtime.sessionKey,
      escalationId,
    ]);
    expect(attentionId.length).toBeGreaterThan(
      MAXIMUM_CONSOLE_ATTENTION_IDENTIFIER_LENGTH,
    );
    composition.persistence.appendEvent(
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
            id: "decision",
            options: [
              { description: "Use route A", id: "a", label: "Route A" },
              { description: "Use route B", id: "b", label: "Route B" },
            ],
            prompt: "Choose a route",
          },
        ],
        stage: runtime.stageId!,
      },
    );

    await expect(composition.escalation.replayPendingRoutes()).rejects.toThrow(
      `exceeds the console attention identity bound of ${MAXIMUM_CONSOLE_ATTENTION_IDENTIFIER_LENGTH} characters`,
    );
    expect(
      composition.escalation.pendingEscalations(runtime.instanceId),
    ).toMatchObject([{ attentionId, escalationId }]);
    expect(composition.attention.list()).toEqual([]);
    await composition.close();
  });

  it("replays a within-bound raw pending identity without remapping", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const composition = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage,
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
    });
    await composition.start();
    const runtime = composition.persistence.listReconcilerRuntime()[0]!;
    const escalationId = "legacy-choice";
    const attentionId = JSON.stringify([
      runtime.instanceId,
      runtime.sessionKey,
      escalationId,
    ]);
    expect(attentionId.length).toBeLessThanOrEqual(
      MAXIMUM_CONSOLE_ATTENTION_IDENTIFIER_LENGTH,
    );
    composition.persistence.appendEvent(
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
            id: "decision",
            options: [
              { description: "Use route A", id: "a", label: "Route A" },
              { description: "Use route B", id: "b", label: "Route B" },
            ],
            prompt: "Choose a route",
          },
        ],
        stage: runtime.stageId!,
      },
    );

    await composition.escalation.replayPendingRoutes();
    expect(composition.attention.list()).toMatchObject([{ attentionId }]);
    expect(
      composition.escalation.pendingEscalations(runtime.instanceId),
    ).toMatchObject([{ attentionId, escalationId }]);
    await composition.close();
  });

  it("routes approval and user input through the accepted session observer", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const t3 = new SyntheticT3();
    const composition = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage,
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    });
    await composition.start();
    const runtime = composition.persistence.listReconcilerRuntime()[0]!;
    await composition.attention.raise({
      attentionId: "approval-attention",
      instanceId: runtime.instanceId,
      kind: "approval",
      message: "Approval required",
      requestId: "approval-one",
      sessionKey: runtime.sessionKey!,
      threadId: runtime.threadId!,
    });
    const approval = composition.attention.list()[0]!;
    await composition.consoleActions.execute({
      action: approval.actions[0]!,
      attention: approval,
    });
    expect(t3.approvalResponses).toEqual([
      {
        commandId: "approval-attention",
        decision: "accept",
        requestId: "approval-one",
        threadId: runtime.threadId,
      },
    ]);

    await composition.attention.raise({
      attentionId: "user-input-attention",
      instanceId: runtime.instanceId,
      kind: "user-input",
      message: "Input required",
      questions: [
        {
          header: "Direction",
          id: "question-one",
          multiSelect: false,
          options: [
            { description: "First route", label: "First" },
            { description: "Second route", label: "Second" },
          ],
          question: "Choose a route",
        },
      ],
      requestId: "input-one",
      sessionKey: runtime.sessionKey!,
      threadId: runtime.threadId!,
    });
    const userInput = composition.attention.list()[0]!;
    expect(userInput.actions[0]?.input).toMatchObject({
      questions: [{ header: "Direction", prompt: "Choose a route" }],
    });
    await composition.consoleActions.execute({
      action: userInput.actions[0]!,
      answers: { "question-one": "Second" },
      attention: userInput,
    });
    expect(t3.userInputResponses).toEqual([
      {
        answers: { "question-one": "Second" },
        commandId: "user-input-attention",
        requestId: "input-one",
        threadId: runtime.threadId,
      },
    ]);
    expect(composition.attention.list()).toEqual([]);
    await composition.close();
  });

  it("settles only the selected request-specific approval under retry", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const t3 = new SyntheticT3();
    const composition = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage,
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    });
    await composition.start();
    const runtime = composition.persistence.listReconcilerRuntime()[0]!;
    for (const suffix of ["first", "second"]) {
      await composition.attention.raise({
        attentionId: `approval-${suffix}`,
        instanceId: runtime.instanceId,
        kind: "approval",
        message: `Approval ${suffix}`,
        requestId: `request-${suffix}`,
        sessionKey: runtime.sessionKey!,
        threadId: runtime.threadId!,
      });
    }
    const second = composition.attention
      .list()
      .find(({ attentionId }) => attentionId === "approval-second")!;

    await composition.consoleActions.execute({
      action: second.actions[0]!,
      attention: second,
    });
    await composition.consoleActions.execute({
      action: second.actions[0]!,
      attention: second,
    });

    expect(t3.approvalResponses).toEqual([
      {
        commandId: "approval-second",
        decision: "accept",
        requestId: "request-second",
        threadId: runtime.threadId,
      },
    ]);
    expect(composition.attention.list()).toMatchObject([
      {
        attentionId: "approval-first",
        message: "Approval first",
      },
    ]);
    await composition.close();
  });

  it("keeps failed effects unresolved and rejects a changed durable action", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const t3 = new FailingApprovalT3();
    const composition = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage,
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    });
    await composition.start();
    const runtime = composition.persistence.listReconcilerRuntime()[0]!;
    await composition.attention.raise({
      attentionId: "approval-attention",
      instanceId: runtime.instanceId,
      kind: "approval",
      message: "Approval required",
      requestId: "approval-one",
      sessionKey: runtime.sessionKey!,
      threadId: runtime.threadId!,
    });
    const attention = composition.attention.list()[0]!;
    await expect(
      composition.consoleActions.execute({
        action: attention.actions[0]!,
        answers: { unsupported: "answer" },
        attention,
      }),
    ).rejects.toThrow("request body contains an unsupported field");
    expect(
      composition.persistence.effectIntentRecorded(
        "console-attention-action",
        attention.attentionId,
      ),
    ).toBe(false);
    await expect(
      composition.consoleActions.execute({
        action: attention.actions[0]!,
        attention,
      }),
    ).rejects.toThrow("Injected approval failure");
    expect(composition.attention.list()).toHaveLength(1);
    expect(
      composition.persistence.effectCompleted(
        "console-attention-action",
        attention.attentionId,
      ),
    ).toBe(false);
    const changedAction = {
      ...attention.actions[0]!,
      contract: {
        ...attention.actions[0]!.contract,
        threadId: "thread-other",
      },
    };
    const attentionState = globalThis.structuredClone(attention);
    delete (attentionState as Partial<typeof attentionState>).fingerprint;
    const changedAttention = createConsoleAttention({
      ...attentionState,
      actions: [changedAction, ...attention.actions.slice(1)],
    });
    await expect(
      composition.consoleActions.execute({
        action: changedAction,
        attention: changedAttention,
      }),
    ).rejects.toThrow("changed durable identity");

    t3.fail = false;
    await composition.consoleActions.execute({
      action: attention.actions[0]!,
      attention,
    });
    expect(composition.attention.list()).toEqual([]);
    expect(t3.approvalResponses).toHaveLength(1);
    await composition.close();
  });

  it("replays a completed durable action without repeating its effect", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const t3 = new SyntheticT3();
    let composition = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage,
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    });
    await composition.start();
    const runtime = composition.persistence.listReconcilerRuntime()[0]!;
    await composition.attention.raise({
      attentionId: "approval-attention",
      instanceId: runtime.instanceId,
      kind: "approval",
      message: "Approval required",
      requestId: "approval-one",
      sessionKey: runtime.sessionKey!,
      threadId: runtime.threadId!,
    });
    const attention = composition.attention.list()[0]!;
    await composition.consoleActions.execute({
      action: attention.actions[0]!,
      attention,
    });
    await composition.close();

    composition = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage,
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    });
    await composition.consoleActions.execute({
      action: attention.actions[0]!,
      attention,
    });
    expect(t3.approvalResponses).toHaveLength(1);
    expect(composition.attention.list()).toEqual([]);
    await composition.close();
  });
});
