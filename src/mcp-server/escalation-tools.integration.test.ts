// ---
// relationships:
//   verifies: heddle
// ---

import process from "node:process";
import { setImmediate } from "node:timers";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SqlitePersistence } from "../persistence/index.js";
import { EscalationCoordinator } from "./escalation-coordinator.js";
import { WorkflowMcpSessionResolver } from "./session-binding.js";
import {
  cleanupEscalationFixtures,
  connectEscalationClient,
  createEscalationFixture,
  createEscalationInstance,
  sampleEscalationAnswer,
  sampleEscalationQuestions,
} from "./escalation-tools.test-support.js";

afterEach(cleanupEscalationFixtures);

describe("workflow MCP escalation tools", () => {
  it("rejects advance while the session has a pending escalation", async () => {
    const subject = await createEscalationFixture();
    createEscalationInstance(subject.persistence, "instance-advance", [
      {
        sessionKey: "top",
        token: "token-advance",
        tools: ["advance", "escalate"],
      },
    ]);
    const client = await connectEscalationClient(
      subject.url,
      "token-advance",
      "advance-client",
    );
    const escalation = await client.callTool({
      arguments: {
        escalationId: "advance-choice",
        questions: sampleEscalationQuestions,
      },
      name: "escalate",
    });
    await vi.waitFor(() => expect(subject.attentions).toHaveLength(1));

    await expect(
      client.callTool({
        arguments: { disposition: "complete" },
        name: "advance",
      }),
    ).resolves.toMatchObject({ isError: true });
    expect(subject.lifecycleResumes).toHaveLength(0);

    await subject.coordinator.answerAsOperator({
      answers: sampleEscalationAnswer,
      escalationId: "advance-choice",
      instanceId: "instance-advance",
      ownerSessionKey: "top",
    });
    expect(escalation).toMatchObject({
      structuredContent: {
        awaitingAnswer: true,
        escalationId: "advance-choice",
      },
    });
    await expect(
      client.callTool({
        arguments: { disposition: "complete" },
        name: "advance",
      }),
    ).resolves.toMatchObject({
      structuredContent: {
        instanceId: "instance-advance",
        status: "completed",
      },
    });
    expect(subject.lifecycleResumes).toHaveLength(1);
  });

  it("rejects parent advance while a child escalation awaits its answer", async () => {
    const subject = await createEscalationFixture();
    createEscalationInstance(subject.persistence, "instance-family-advance", [
      {
        sessionKey: "parent",
        token: "token-parent-advance",
        tools: ["answer", "advance"],
      },
      {
        parentSessionKey: "parent",
        sessionKey: "child",
        token: "token-child-advance",
        tools: ["escalate"],
      },
    ]);
    const parent = await connectEscalationClient(
      subject.url,
      "token-parent-advance",
      "parent-advance-client",
    );
    const child = await connectEscalationClient(
      subject.url,
      "token-child-advance",
      "child-advance-client",
    );
    const childCall = await child.callTool({
      arguments: {
        escalationId: "child-advance-choice",
        questions: sampleEscalationQuestions,
      },
      name: "escalate",
    });
    await vi.waitFor(() => expect(subject.parentEscalations).toHaveLength(1));

    await expect(
      parent.callTool({
        arguments: { disposition: "complete" },
        name: "advance",
      }),
    ).resolves.toMatchObject({ isError: true });
    expect(subject.lifecycleResumes).toHaveLength(0);

    await expect(
      parent.callTool({
        arguments: {
          answers: sampleEscalationAnswer,
          escalationId: "child-advance-choice",
          ownerSessionKey: "child",
        },
        name: "answer",
      }),
    ).resolves.toMatchObject({
      structuredContent: {
        answered: true,
        escalationId: "child-advance-choice",
      },
    });
    expect(childCall).toMatchObject({
      structuredContent: {
        awaitingAnswer: true,
        escalationId: "child-advance-choice",
      },
    });
    await expect(
      parent.callTool({
        arguments: { disposition: "complete" },
        name: "advance",
      }),
    ).resolves.toMatchObject({
      structuredContent: {
        instanceId: "instance-family-advance",
        status: "completed",
      },
    });
    expect(subject.lifecycleResumes).toHaveLength(1);
  });

  it("serializes concurrent advance and escalation into one valid outcome", async () => {
    let releaseResume!: () => void;
    let resumeStarted!: () => void;
    let escalationOpened!: () => void;
    const resumeRelease = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const resumeStart = new Promise<void>((resolve) => {
      resumeStarted = resolve;
    });
    const opened = new Promise<void>((resolve) => {
      escalationOpened = resolve;
    });
    const subject = await createEscalationFixture({
      attention: async () => escalationOpened(),
      resume: async (input) => {
        resumeStarted();
        await resumeRelease;
        return {
          awaitingNodeIds: [],
          blueprintBlobHash: "a".repeat(40),
          blueprintPath: "blueprints/sample-process.json",
          executionIds: [],
          instanceId: input.instanceId,
          status: "completed",
          validDispositions: [],
        };
      },
    });
    createEscalationInstance(subject.persistence, "instance-race", [
      {
        sessionKey: "racing-session",
        token: "token-race",
        tools: ["advance", "escalate"],
      },
    ]);
    const client = await connectEscalationClient(
      subject.url,
      "token-race",
      "race-client",
    );
    const advance = client.callTool({
      arguments: { disposition: "complete" },
      name: "advance",
    });
    await resumeStart;

    const escalation = client.callTool({
      arguments: {
        escalationId: "race-choice",
        questions: sampleEscalationQuestions,
      },
      name: "escalate",
    });
    const outcome = await Promise.race([
      escalation.then((result) => ({ kind: "result" as const, result })),
      opened.then(() => ({ kind: "opened" as const })),
    ]);
    if (outcome.kind === "opened") {
      await subject.coordinator.answerAsOperator({
        answers: sampleEscalationAnswer,
        escalationId: "race-choice",
        instanceId: "instance-race",
        ownerSessionKey: "racing-session",
      });
      await escalation;
    }
    releaseResume();

    await expect(advance).resolves.toMatchObject({
      structuredContent: {
        instanceId: "instance-race",
        status: "completed",
      },
    });
    expect(outcome).toMatchObject({
      kind: "result",
      result: { isError: true },
    });
    expect(
      subject.coordinator.pendingEscalations("instance-race"),
    ).toHaveLength(0);
  });

  it("returns a durable receipt immediately and delivers the later top-level answer", async () => {
    const subject = await createEscalationFixture();
    createEscalationInstance(subject.persistence, "instance-top", [
      { sessionKey: "top", token: "token-top", tools: ["escalate"] },
    ]);
    const client = await connectEscalationClient(
      subject.url,
      "token-top",
      "top-client",
    );

    const call = await client.callTool({
      arguments: {
        escalationId: "window-choice",
        questions: sampleEscalationQuestions,
      },
      name: "escalate",
    });
    await vi.waitFor(() => expect(subject.attentions).toHaveLength(1));

    expect(call).toMatchObject({
      structuredContent: {
        awaitingAnswer: true,
        escalationId: "window-choice",
      },
    });
    expect(subject.attentions[0]).toMatchObject({
      escalationId: "window-choice",
      instanceId: "instance-top",
      ownerSessionKey: "top",
      questions: sampleEscalationQuestions,
    });
    expect(subject.notifications).toEqual(subject.attentions);
    expect(() =>
      subject.coordinator.requireNoPendingForSession("instance-top", "top"),
    ).toThrow(/pending escalation/);
    await expect(
      client.callTool({
        arguments: {
          escalationId: "window-choice",
          questions: [
            {
              ...sampleEscalationQuestions[0],
              prompt: "Which later delivery window should be used?",
            },
          ],
        },
        name: "escalate",
      }),
    ).resolves.toMatchObject({ isError: true });

    const operatorAnswer = {
      answers: sampleEscalationAnswer,
      escalationId: "window-choice",
      instanceId: "instance-top",
      ownerSessionKey: "top",
    };
    await subject.coordinator.answerAsOperator({
      ...operatorAnswer,
      prose: "Use the ordinary delivery window.",
    });

    expect(subject.deliveredAnswers).toHaveLength(1);
    expect(subject.deliveredAnswers[0]).toMatchObject({
      answered: {
        answers: sampleEscalationAnswer,
        answeredBy: { kind: "operator" },
        prose: "Use the ordinary delivery window.",
      },
      opened: { escalationId: "window-choice" },
    });
    await expect(
      subject.coordinator.answerAsOperator({
        ...operatorAnswer,
        answers: { "delivery-window": "wait" },
      }),
    ).rejects.toThrow(/already answered differently/);
    await expect(
      subject.coordinator.answerAsOperator({
        ...operatorAnswer,
        prose: "Use the ordinary delivery window.",
      }),
    ).resolves.toMatchObject({ answers: sampleEscalationAnswer });
    expect(subject.deliveredAnswers).toHaveLength(1);
    expect(
      subject.persistence
        .replayEvents("instance-top")
        .filter(({ type }) => type === "mcp:escalation-answered"),
    ).toHaveLength(1);
    expect(() =>
      subject.coordinator.requireNoPendingForSession("instance-top", "top"),
    ).not.toThrow();
  });

  it("allows only a parent correlation token to answer its child", async () => {
    const subject = await createEscalationFixture();
    createEscalationInstance(subject.persistence, "instance-family", [
      { sessionKey: "parent", token: "token-parent", tools: ["answer"] },
      {
        parentSessionKey: "parent",
        sessionKey: "child",
        token: "token-child",
        tools: ["escalate"],
      },
      { sessionKey: "peer", token: "token-peer", tools: ["answer"] },
    ]);
    const parent = await connectEscalationClient(
      subject.url,
      "token-parent",
      "parent-client",
    );
    const child = await connectEscalationClient(
      subject.url,
      "token-child",
      "child-client",
    );
    const peer = await connectEscalationClient(
      subject.url,
      "token-peer",
      "peer-client",
    );

    const childCall = child.callTool({
      arguments: {
        escalationId: "child-choice",
        questions: sampleEscalationQuestions,
      },
      name: "escalate",
    });
    await vi.waitFor(() => expect(subject.parentEscalations).toHaveLength(1));
    expect(subject.parentEscalations[0]).toMatchObject({
      escalationId: "child-choice",
      ownerSessionKey: "child",
      parentSessionKey: "parent",
    });
    expect(subject.attentions).toHaveLength(0);
    await expect(
      subject.coordinator.answerAsOperator({
        answers: sampleEscalationAnswer,
        escalationId: "child-choice",
        instanceId: "instance-family",
        ownerSessionKey: "child",
      }),
    ).rejects.toThrow(/answering authority/);

    const answerArguments = {
      answers: sampleEscalationAnswer,
      escalationId: "child-choice",
      ownerSessionKey: "child",
    };
    await expect(
      peer.callTool({ arguments: answerArguments, name: "answer" }),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      parent.callTool({ arguments: answerArguments, name: "answer" }),
    ).resolves.toMatchObject({
      structuredContent: { answered: true, escalationId: "child-choice" },
    });
    await expect(childCall).resolves.toMatchObject({
      structuredContent: {
        awaitingAnswer: true,
        escalationId: "child-choice",
      },
    });
  });

  it("moves answer authority to another session through the same answer predicate", async () => {
    const subject = await createEscalationFixture();
    createEscalationInstance(subject.persistence, "instance-delegated", [
      {
        sessionKey: "parent",
        token: "token-parent-delegated",
        tools: ["answer"],
      },
      {
        parentSessionKey: "parent",
        sessionKey: "child",
        token: "token-child-delegated",
        tools: ["escalate"],
      },
      {
        sessionKey: "adjudicator",
        token: "token-adjudicator",
        tools: ["answer"],
      },
    ]);
    const child = await connectEscalationClient(
      subject.url,
      "token-child-delegated",
      "child-delegated-client",
    );
    const adjudicator = await connectEscalationClient(
      subject.url,
      "token-adjudicator",
      "adjudicator-client",
    );
    await child.callTool({
      arguments: {
        escalationId: "delegated-choice",
        questions: sampleEscalationQuestions,
      },
      name: "escalate",
    });
    await vi.waitFor(() => expect(subject.parentEscalations).toHaveLength(1));

    await subject.coordinator.moveAnswerAuthority({
      escalationId: "delegated-choice",
      instanceId: "instance-delegated",
      ownerSessionKey: "child",
      reason: "The parent requested independent adjudication.",
      to: { kind: "session", sessionKey: "adjudicator" },
    });

    expect(subject.parentEscalations).toHaveLength(2);
    expect(subject.parentEscalations[1]?.answeringAuthority).toEqual({
      kind: "session",
      sessionKey: "adjudicator",
    });
    await expect(
      adjudicator.callTool({
        arguments: {
          answers: sampleEscalationAnswer,
          escalationId: "delegated-choice",
          ownerSessionKey: "child",
        },
        name: "answer",
      }),
    ).resolves.toMatchObject({
      structuredContent: { answered: true, escalationId: "delegated-choice" },
    });
  });

  it("lets the operator answer after delegated authority is handed back", async () => {
    const subject = await createEscalationFixture();
    createEscalationInstance(subject.persistence, "instance-handback", [
      {
        sessionKey: "parent",
        token: "token-parent-handback",
        tools: ["answer"],
      },
      {
        parentSessionKey: "parent",
        sessionKey: "child",
        token: "token-child-handback",
        tools: ["escalate"],
      },
    ]);
    const child = await connectEscalationClient(
      subject.url,
      "token-child-handback",
      "child-handback-client",
    );
    await child.callTool({
      arguments: {
        escalationId: "handback-choice",
        questions: sampleEscalationQuestions,
      },
      name: "escalate",
    });
    await vi.waitFor(() => expect(subject.parentEscalations).toHaveLength(1));

    await subject.coordinator.moveAnswerAuthority({
      escalationId: "handback-choice",
      instanceId: "instance-handback",
      ownerSessionKey: "child",
      reason: "The parent declined to decide.",
      to: { kind: "operator" },
    });
    await expect(
      subject.coordinator.answerAsOperator({
        answers: sampleEscalationAnswer,
        escalationId: "handback-choice",
        instanceId: "instance-handback",
        ownerSessionKey: "child",
      }),
    ).resolves.toMatchObject({ answeredBy: { kind: "operator" } });
  });

  it("delivers a durably answered escalation exactly once after restart", async () => {
    const subject = await createEscalationFixture();
    createEscalationInstance(subject.persistence, "instance-replay", [
      { sessionKey: "top", token: "token-replay", tools: ["escalate"] },
    ]);
    const binding = await new WorkflowMcpSessionResolver(
      subject.persistence,
    ).resolve("token-replay");
    const escalationId = "e".repeat(128);
    await expect(
      subject.coordinator.escalate(binding, {
        escalationId,
        questions: sampleEscalationQuestions,
      }),
    ).resolves.toEqual({ awaitingAnswer: true, escalationId });
    await vi.waitFor(() => expect(subject.attentions).toHaveLength(1));
    const attentionId = subject.attentions[0]!.attentionId;
    expect(attentionId).toHaveLength(75);
    subject.persistence.appendEvent(
      "instance-replay",
      "mcp:escalation-answered",
      {
        answeredBy: { kind: "operator" },
        answers: sampleEscalationAnswer,
        escalationId,
        ownerSessionKey: "top",
        prose: "Recorded before the process stopped.",
      },
    );
    subject.persistence.close();

    const recoveredPersistence = new SqlitePersistence({
      stateDirectory: subject.stateDirectory,
    });
    const delivered: unknown[] = [];
    const recorded: unknown[] = [];
    const recovered = new EscalationCoordinator({
      attention: {
        raise: async () => {
          throw new Error("replayed escalation must not raise twice");
        },
      },
      decisionLog: {
        record: async (value) => void recorded.push(value),
      },
      delivery: {
        deliver: async (value) => void delivered.push(value),
      },
      pushover: {
        send: async () => {
          throw new Error("replayed escalation must not notify twice");
        },
      },
      session: {
        steer: async () => {
          throw new Error("top-level escalation must not steer a parent");
        },
      },
      persistence: recoveredPersistence,
    });

    expect(recovered.pendingEscalations("instance-replay")).toEqual([]);
    await recovered.replayPendingDeliveries();
    await recovered.replayPendingDeliveries();
    expect(recorded).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      answered: { answeredBy: { kind: "operator" } },
      opened: { attentionId, escalationId, ownerSessionKey: "top" },
    });
    expect(
      recoveredPersistence
        .replayEvents("instance-replay")
        .filter(({ type }) => type.startsWith("mcp:escalation-"))
        .map(({ type }) => type),
    ).toEqual([
      "mcp:escalation-opened",
      "mcp:escalation-attention-raised",
      "mcp:escalation-notified",
      "mcp:escalation-answered",
      "mcp:escalation-decision-recorded",
      "mcp:escalation-delivery-completed",
    ]);
    recoveredPersistence.close();
  });

  it("uses distinct delivery identities when an escalation ID recurs in a later session", async () => {
    const subject = await createEscalationFixture();
    createEscalationInstance(subject.persistence, "instance-recurrence", [
      { sessionKey: "first", token: "token-first", tools: ["escalate"] },
      { sessionKey: "second", token: "token-second", tools: ["escalate"] },
    ]);
    const resolver = new WorkflowMcpSessionResolver(subject.persistence);
    for (const [sessionKey, token] of [
      ["first", "token-first"],
      ["second", "token-second"],
    ] as const) {
      await subject.coordinator.escalate(await resolver.resolve(token), {
        escalationId: "repeated-choice",
        questions: sampleEscalationQuestions,
      });
      await subject.coordinator.answerAsOperator({
        answers: sampleEscalationAnswer,
        escalationId: "repeated-choice",
        instanceId: "instance-recurrence",
        ownerSessionKey: sessionKey,
      });
    }

    expect(subject.deliveredAnswers).toHaveLength(2);
    expect(
      new Set(subject.deliveredAnswers.map(({ commandId }) => commandId)),
    ).toHaveLength(2);
    expect(
      new Set(subject.deliveredAnswers.map(({ messageId }) => messageId)),
    ).toHaveLength(2);
  });

  it("contains a rejected asynchronous route after returning its immediate receipt", async () => {
    const failure = new Error("sample attention route failed");
    const subject = await createEscalationFixture({
      attention: async () => Promise.reject(failure),
    });
    createEscalationInstance(subject.persistence, "instance-route-rejection", [
      {
        sessionKey: "top",
        token: "token-route-rejection",
        tools: ["escalate"],
      },
    ]);
    const binding = await new WorkflowMcpSessionResolver(
      subject.persistence,
    ).resolve("token-route-rejection");
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await expect(
        subject.coordinator.escalate(binding, {
          escalationId: "route-rejection",
          questions: sampleEscalationQuestions,
        }),
      ).resolves.toEqual({
        awaitingAnswer: true,
        escalationId: "route-rejection",
      });
      await vi.waitFor(() => expect(subject.attentions).toHaveLength(1));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      await expect(subject.coordinator.replayPendingRoutes()).rejects.toBe(
        failure,
      );
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("replays a retained answer that predates explicit answering authority", async () => {
    const subject = await createEscalationFixture();
    createEscalationInstance(subject.persistence, "instance-legacy-answer", [
      { sessionKey: "top", token: "token-legacy", tools: ["escalate"] },
    ]);
    subject.persistence.appendEvent(
      "instance-legacy-answer",
      "mcp:escalation-opened",
      {
        attentionId: "attention-legacy-answer",
        escalationId: "legacy-choice",
        openedAt: "2026-01-01T00:00:00.000Z",
        ownerSessionKey: "top",
        questions: sampleEscalationQuestions,
        stage: "assess",
      },
    );
    subject.persistence.appendEvent(
      "instance-legacy-answer",
      "mcp:escalation-answered",
      {
        answers: sampleEscalationAnswer,
        escalationId: "legacy-choice",
        ownerSessionKey: "top",
      },
    );

    expect(
      subject.coordinator.pendingEscalations("instance-legacy-answer"),
    ).toEqual([]);
    await subject.coordinator.replayPendingDeliveries();
    expect(subject.deliveredAnswers).toMatchObject([
      { answered: { answeredBy: { kind: "operator" } } },
    ]);
  });

  it("rejects a malformed persisted answer before clearing pending state", async () => {
    const subject = await createEscalationFixture();
    createEscalationInstance(subject.persistence, "instance-invalid-answer", [
      { sessionKey: "top", token: "token-invalid", tools: ["escalate"] },
    ]);
    const binding = await new WorkflowMcpSessionResolver(
      subject.persistence,
    ).resolve("token-invalid");
    await subject.coordinator.escalate(binding, {
      escalationId: "invalid-choice",
      questions: sampleEscalationQuestions,
    });
    await vi.waitFor(() => expect(subject.attentions).toHaveLength(1));

    subject.persistence.appendEvent(
      "instance-invalid-answer",
      "mcp:escalation-answered",
      {
        answeredBy: { kind: "operator" },
        answers: { "delivery-window": "unoffered" },
        escalationId: "invalid-choice",
        ownerSessionKey: "top",
      },
    );

    expect(() =>
      subject.coordinator.pendingEscalations("instance-invalid-answer"),
    ).toThrow(/does not name an offered option/);
  });

  it("rejects an answer event that precedes its open event", async () => {
    const subject = await createEscalationFixture();
    createEscalationInstance(subject.persistence, "instance-answer-first", [
      { sessionKey: "top", token: "token-answer-first", tools: ["escalate"] },
    ]);
    subject.persistence.appendEvent(
      "instance-answer-first",
      "mcp:escalation-answered",
      {
        answeredBy: { kind: "operator" },
        answers: sampleEscalationAnswer,
        escalationId: "answer-first-choice",
        ownerSessionKey: "top",
      },
    );
    subject.persistence.appendEvent(
      "instance-answer-first",
      "mcp:escalation-opened",
      {
        attentionId: "attention-answer-first",
        escalationId: "answer-first-choice",
        openedAt: "2026-01-01T00:00:00.000Z",
        ownerSessionKey: "top",
        questions: sampleEscalationQuestions,
        stage: "assess",
      },
    );

    expect(() =>
      subject.coordinator.pendingEscalations("instance-answer-first"),
    ).toThrow(/answer precedes its open event/);
  });

  it("rejects conflicting answer events during replay", async () => {
    const subject = await createEscalationFixture();
    createEscalationInstance(subject.persistence, "instance-answer-conflict", [
      {
        sessionKey: "top",
        token: "token-answer-conflict",
        tools: ["escalate"],
      },
    ]);
    subject.persistence.appendEvent(
      "instance-answer-conflict",
      "mcp:escalation-opened",
      {
        attentionId: "attention-answer-conflict",
        escalationId: "answer-conflict-choice",
        openedAt: "2026-01-01T00:00:00.000Z",
        ownerSessionKey: "top",
        questions: sampleEscalationQuestions,
        stage: "assess",
      },
    );
    for (const answers of [
      sampleEscalationAnswer,
      { "delivery-window": "wait" },
    ]) {
      subject.persistence.appendEvent(
        "instance-answer-conflict",
        "mcp:escalation-answered",
        {
          answeredBy: { kind: "operator" },
          answers,
          escalationId: "answer-conflict-choice",
          ownerSessionKey: "top",
        },
      );
    }

    expect(() =>
      subject.coordinator.pendingEscalations("instance-answer-conflict"),
    ).toThrow(/conflicting answer events/);
  });
});
