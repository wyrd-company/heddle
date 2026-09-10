// ---
// relationships:
//   verifies: heddle
// ---
import { setImmediate } from "node:timers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EscalationCoordinator } from "./escalation-coordinator.js";
import { EscalationHistory } from "./escalation-history.js";
import { WorkflowMcpSessionResolver } from "./session-binding.js";
import {
  cleanupEscalationFixtures,
  createEscalationFixture,
  createEscalationInstance,
  sampleEscalationAnswer,
  sampleEscalationQuestions,
} from "./escalation-tools.test-support.js";

afterEach(cleanupEscalationFixtures);
const bindingFor = async (
  subject: Awaited<ReturnType<typeof createEscalationFixture>>,
) => {
  createEscalationInstance(subject.persistence, "instance-a", [
    { sessionKey: "owner-a", token: "credential-a", tools: ["answer"] },
  ]);
  return new WorkflowMcpSessionResolver(subject.persistence).resolve(
    "credential-a",
  );
};
const input = {
  escalationId: "question-a",
  requestId: "native-a",
  threadId: "thread-a",
  questions: sampleEscalationQuestions,
};

describe("native question cancellation", () => {
  it("keeps a cancelled occurrence's adjudicator alive while its own question remains pending", async () => {
    const stop = vi.fn();
    const subject = await createEscalationFixture({
      adjudication: {
        start: async () => ({ modelSlug: "sample-model" }),
        stop,
      },
    });
    const binding = await bindingFor(subject);
    await subject.coordinator.escalate(binding, input);
    await subject.coordinator.replayPendingRoutes();
    const original = subject.coordinator.pendingEscalations("instance-a")[0]!;
    if (original.answeringAuthority.kind !== "adjudication")
      throw new Error("Expected adjudication");
    const history = new EscalationHistory(subject.persistence);
    const clarification = history.open(
      { ...binding, sessionKey: original.answeringAuthority.sessionKey },
      {
        ...input,
        escalationId: "clarification",
        requestId: "clarification-native",
        threadId: "clarification-thread",
      },
      "2026-01-01T00:00:00Z",
    ).opened;
    subject.coordinator.withdraw(original);
    await subject.coordinator.replayPendingRoutes();
    expect(stop).not.toHaveBeenCalled();
    subject.coordinator.withdraw(clarification);
    await subject.coordinator.replayPendingRoutes();
    expect(stop).toHaveBeenCalledOnce();
  });
  it("waits for an in-flight adjudication start before durable cancellation cleanup and never synthesizes settlement", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stop = vi.fn(async () => undefined);
    const adjudication = {
      start: vi.fn(async () => {
        await gate;
        return { modelSlug: "sample-model" };
      }),
      stop,
    };
    const subject = await createEscalationFixture({ adjudication });
    const binding = await bindingFor(subject);
    await subject.coordinator.escalate(binding, input);
    const opened = subject.coordinator.pendingEscalations("instance-a")[0]!;
    subject.coordinator.withdraw(opened);
    const cleanup = subject.coordinator.replayPendingRoutes();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stop).not.toHaveBeenCalled();
    } finally {
      release();
      await cleanup;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(stop).toHaveBeenCalledExactlyOnceWith({
      reason: "withdrawn",
      sessionKey:
        opened.answeringAuthority.kind === "adjudication"
          ? opened.answeringAuthority.sessionKey
          : "unexpected",
    });
    const recovered = new EscalationCoordinator({
      persistence: subject.persistence,
      adjudication,
      attention: { raise: vi.fn() },
      pushover: { send: vi.fn() },
      session: { steer: vi.fn() },
    });
    await recovered.replayPendingRoutes();
    await recovered.escalate(binding, input);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(adjudication.start).toHaveBeenCalledTimes(1);
    expect(
      subject.persistence
        .replayEvents("instance-a")
        .filter((event) =>
          [
            "mcp:escalation-answered",
            "mcp:escalation-authority-moved",
          ].includes(event.type),
        ),
    ).toEqual([]);
    expect(subject.deliveredAnswers).toEqual([]);
  });

  it("does not notify a withdrawn operator question after a delayed attention write", async () => {
    const subject = await createEscalationFixture();
    const binding = await bindingFor(subject);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const raised = new Set<string>();
    const send = vi.fn();
    const coordinator = new EscalationCoordinator({
      persistence: subject.persistence,
      attention: {
        raise: async ({ attentionId }) => {
          await gate;
          raised.add(attentionId);
        },
        resolve: (attentionId) => {
          raised.delete(attentionId);
        },
      },
      pushover: { send },
      session: { steer: vi.fn() },
    });
    await coordinator.escalate(binding, input);
    coordinator.withdraw(coordinator.pendingEscalations("instance-a")[0]!);
    const cleanup = coordinator.replayPendingRoutes();
    release();
    await cleanup;
    expect(raised.size).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps cancellation final when the in-flight adjudication start fails", async () => {
    const subject = await createEscalationFixture();
    let reject!: (error: Error) => void;
    const gate = new Promise<never>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    const coordinator = new EscalationCoordinator({
      persistence: subject.persistence,
      adjudication: { start: () => gate, stop: vi.fn() },
      attention: { raise: vi.fn() },
      pushover: { send: vi.fn() },
      session: { steer: vi.fn() },
    });
    await coordinator.escalate(await bindingFor(subject), input);
    const activeReplay = coordinator.replayPendingRoutes();
    coordinator.withdraw(coordinator.pendingEscalations("instance-a")[0]!);
    const cleanup = coordinator.replayPendingRoutes();
    reject(new Error("start transport failed"));
    await expect(activeReplay).resolves.toBeUndefined();
    await expect(cleanup).resolves.toBeUndefined();
    expect(
      subject.persistence
        .replayEvents("instance-a")
        .filter(({ type }) => type === "mcp:escalation-authority-moved"),
    ).toEqual([]);
  });

  it("does not start a withdrawn route from an earlier replay snapshot", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const start = vi.fn(async () => {
      await gate;
      return { modelSlug: "sample-model" };
    });
    const subject = await createEscalationFixture({
      adjudication: { start, stop: vi.fn() },
    });
    const binding = await bindingFor(subject);
    await subject.coordinator.escalate(binding, input);
    const history = new EscalationHistory(subject.persistence);
    const later = history.open(
      binding,
      { ...input, escalationId: "later-question", requestId: "later-native" },
      "2026-01-01T00:00:00Z",
      { kind: "adjudication", sessionKey: "later-adjudicator" },
    ).opened;
    const replay = subject.coordinator.replayPendingRoutes();
    subject.coordinator.withdraw(later);
    release();
    await replay;
    expect(start).toHaveBeenCalledOnce();
  });

  it("retries cancellation cleanup after a stop failure without reopening or redelivering the question", async () => {
    const stop = vi
      .fn()
      .mockRejectedValueOnce(new Error("stop transport failed"))
      .mockResolvedValue(undefined);
    const subject = await createEscalationFixture({
      adjudication: {
        start: async () => ({ modelSlug: "sample-model" }),
        stop,
      },
    });
    await subject.coordinator.escalate(await bindingFor(subject), input);
    await subject.coordinator.replayPendingRoutes();
    subject.coordinator.withdraw(
      subject.coordinator.pendingEscalations("instance-a")[0]!,
    );
    await expect(subject.coordinator.replayPendingRoutes()).rejects.toThrow(
      "stop transport failed",
    );
    expect(subject.coordinator.pendingEscalations("instance-a")).toEqual([]);
    await subject.coordinator.replayPendingRoutes();
    await subject.coordinator.replayPendingRoutes();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(subject.deliveredAnswers).toEqual([]);
  });

  it.each(["requestId", "threadId"] as const)(
    "rejects a retried native %s mismatch",
    async (field) => {
      const subject = await createEscalationFixture();
      const binding = await bindingFor(subject);
      const history = new EscalationHistory(subject.persistence);
      history.open(binding, input, "2026-01-01T00:00:00Z");
      expect(() =>
        history.open(
          binding,
          { ...input, [field]: "another-native-identity" },
          "2026-01-01T00:00:00Z",
        ),
      ).toThrow(/retried with different/);
      const opened = history.pending("instance-a")[0]!;
      expect(opened).toMatchObject({
        requestId: input.requestId,
        threadId: input.threadId,
      });
      history.withdraw(opened);
      expect(() =>
        history.answer(opened, sampleEscalationAnswer, { kind: "operator" }),
      ).toThrow(/not pending/);
    },
  );
});
