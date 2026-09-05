// ---
// relationships:
//   verifies: heddle
// ---

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
    const escalation = client.callTool({
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

    subject.coordinator.answerAsOperator({
      answers: sampleEscalationAnswer,
      escalationId: "advance-choice",
      instanceId: "instance-advance",
      ownerSessionKey: "top",
    });
    await expect(escalation).resolves.toMatchObject({
      structuredContent: { answers: sampleEscalationAnswer },
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
    const childCall = child.callTool({
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
    await expect(childCall).resolves.toMatchObject({
      structuredContent: { answers: sampleEscalationAnswer },
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
      subject.coordinator.answerAsOperator({
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

  it("holds a top-level escalation until its attention entry is answered", async () => {
    const subject = await createEscalationFixture();
    createEscalationInstance(subject.persistence, "instance-top", [
      { sessionKey: "top", token: "token-top", tools: ["escalate"] },
    ]);
    const client = await connectEscalationClient(
      subject.url,
      "token-top",
      "top-client",
    );

    let settled = false;
    const call = client
      .callTool({
        arguments: {
          escalationId: "window-choice",
          questions: sampleEscalationQuestions,
        },
        name: "escalate",
      })
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(subject.attentions).toHaveLength(1));

    expect(settled).toBe(false);
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
    subject.coordinator.answerAsOperator(operatorAnswer);

    await expect(call).resolves.toMatchObject({
      structuredContent: {
        answers: sampleEscalationAnswer,
        escalationId: "window-choice",
      },
    });
    expect(() =>
      subject.coordinator.answerAsOperator({
        ...operatorAnswer,
        answers: { "delivery-window": "wait" },
      }),
    ).toThrow(/already answered differently/);
    expect(subject.coordinator.answerAsOperator(operatorAnswer)).toMatchObject({
      answers: sampleEscalationAnswer,
    });
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
    expect(() =>
      subject.coordinator.answerAsOperator({
        answers: sampleEscalationAnswer,
        escalationId: "child-choice",
        instanceId: "instance-family",
        ownerSessionKey: "child",
      }),
    ).toThrow(/parent session/);

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
      structuredContent: { answers: sampleEscalationAnswer },
    });
  });

  it("replays a pending call and its answer after persistence restart", async () => {
    const subject = await createEscalationFixture();
    createEscalationInstance(subject.persistence, "instance-replay", [
      { sessionKey: "top", token: "token-replay", tools: ["escalate"] },
    ]);
    const binding = await new WorkflowMcpSessionResolver(
      subject.persistence,
    ).resolve("token-replay");
    const abort = new globalThis.AbortController();
    const escalationId = "e".repeat(128);
    const abandoned = subject.coordinator.escalate(
      binding,
      {
        escalationId,
        questions: sampleEscalationQuestions,
      },
      abort.signal,
    );
    await vi.waitFor(() => expect(subject.attentions).toHaveLength(1));
    const attentionId = subject.attentions[0]!.attentionId;
    expect(attentionId).toHaveLength(75);
    abort.abort(new Error("simulated process stop"));
    await expect(abandoned).rejects.toThrow(/simulated process stop/);
    subject.persistence.close();

    const recoveredPersistence = new SqlitePersistence({
      stateDirectory: subject.stateDirectory,
    });
    const recovered = new EscalationCoordinator({
      attention: {
        raise: async () => {
          throw new Error("replayed escalation must not raise twice");
        },
      },
      pushover: {
        send: async () => {
          throw new Error("replayed escalation must not notify twice");
        },
      },
      parent: {
        steer: async () => {
          throw new Error("top-level escalation must not steer a parent");
        },
      },
      persistence: recoveredPersistence,
    });

    expect(recovered.pendingEscalations("instance-replay")).toMatchObject([
      {
        attentionId,
        escalationId,
        ownerSessionKey: "top",
      },
    ]);
    const recoveredBinding = await new WorkflowMcpSessionResolver(
      recoveredPersistence,
    ).resolve("token-replay");
    const reattached = recovered.escalate(recoveredBinding, {
      escalationId,
      questions: sampleEscalationQuestions,
    });
    recovered.answerAsOperator({
      answers: sampleEscalationAnswer,
      escalationId,
      instanceId: "instance-replay",
      ownerSessionKey: "top",
    });
    await expect(reattached).resolves.toEqual({
      answers: sampleEscalationAnswer,
      escalationId,
    });
    await expect(
      recovered.escalate(recoveredBinding, {
        escalationId,
        questions: sampleEscalationQuestions,
      }),
    ).resolves.toEqual({
      answers: sampleEscalationAnswer,
      escalationId,
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
    ]);
    recoveredPersistence.close();
  });

  it("rejects a malformed persisted answer before clearing pending state", async () => {
    const subject = await createEscalationFixture();
    createEscalationInstance(subject.persistence, "instance-invalid-answer", [
      { sessionKey: "top", token: "token-invalid", tools: ["escalate"] },
    ]);
    const binding = await new WorkflowMcpSessionResolver(
      subject.persistence,
    ).resolve("token-invalid");
    const abort = new globalThis.AbortController();
    const abandoned = subject.coordinator.escalate(
      binding,
      {
        escalationId: "invalid-choice",
        questions: sampleEscalationQuestions,
      },
      abort.signal,
    );
    await vi.waitFor(() => expect(subject.attentions).toHaveLength(1));
    abort.abort(new Error("simulated caller stop"));
    await expect(abandoned).rejects.toThrow(/simulated caller stop/);

    subject.persistence.appendEvent(
      "instance-invalid-answer",
      "mcp:escalation-answered",
      {
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
