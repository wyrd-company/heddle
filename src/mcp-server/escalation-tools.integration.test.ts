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

const openQuestion = async (
  subject: Awaited<ReturnType<typeof createEscalationFixture>>,
  token: string,
  input: Omit<
    Parameters<EscalationCoordinator["escalate"]>[1],
    "requestId" | "threadId"
  > & { requestId?: string; threadId?: string },
) =>
  subject.coordinator.escalate(
    await new WorkflowMcpSessionResolver(subject.persistence).resolve(token),
    { requestId: "request-sample", threadId: "thread-sample", ...input },
  );

describe("workflow MCP escalation tools", () => {
  it("routes each top-level escalation occurrence to one fresh adjudication session", async () => {
    const starts: Array<{ escalationId: string; sessionKey: string }> = [];
    const subject = await createEscalationFixture({
      adjudication: {
        start: async (opened) => {
          starts.push({
            escalationId: opened.escalationId,
            sessionKey: opened.answeringAuthority.sessionKey,
          });
          return { modelSlug: "sample-capable-model" };
        },
        stop: async () => undefined,
      },
    });
    createEscalationInstance(subject.persistence, "instance-adjudication", [
      {
        sessionKey: "top",
        token: "token-adjudication",
        tools: [],
      },
    ]);
    const binding = await new WorkflowMcpSessionResolver(
      subject.persistence,
    ).resolve("token-adjudication");

    for (const escalationId of ["first-choice", "second-choice"]) {
      await subject.coordinator.escalate(binding, {
        escalationId,
        requestId: "request-sample",
        threadId: "thread-sample",
        questions: sampleEscalationQuestions,
      });
    }
    await vi.waitFor(() => expect(starts).toHaveLength(2));

    expect(new Set(starts.map(({ sessionKey }) => sessionKey))).toHaveLength(2);
    expect(subject.attentions).toHaveLength(0);
    await subject.coordinator.replayPendingRoutes();
    expect(starts).toHaveLength(2);
  });

  it("fails a top-level adjudication start closed to operator attention", async () => {
    const subject = await createEscalationFixture({
      adjudication: {
        start: async () => {
          throw new Error("sample alias exhausted");
        },
        stop: async () => undefined,
      },
    });
    createEscalationInstance(subject.persistence, "instance-start-failure", [
      {
        sessionKey: "top",
        token: "token-start-failure",
        tools: [],
      },
    ]);
    const binding = await new WorkflowMcpSessionResolver(
      subject.persistence,
    ).resolve("token-start-failure");

    await subject.coordinator.escalate(binding, {
      escalationId: "start-failure",
      requestId: "request-sample",
      threadId: "thread-sample",
      questions: sampleEscalationQuestions,
    });
    await vi.waitFor(() => expect(subject.notifications).toHaveLength(1));

    expect(subject.attentions[0]).toMatchObject({
      adjudication: { cause: "sample alias exhausted" },
      requestId: "request-sample",
      threadId: "thread-sample",
      questions: sampleEscalationQuestions,
    });
    expect(subject.notifications).toEqual(subject.attentions);
  });

  it("answers through the adjudication authority and records model reasoning", async () => {
    const stopped: string[] = [];
    const subject = await createEscalationFixture({
      adjudication: {
        start: async () => ({ modelSlug: "sample-capable-model" }),
        stop: async ({ sessionKey }) => void stopped.push(sessionKey),
      },
    });
    createEscalationInstance(subject.persistence, "instance-decided", [
      { sessionKey: "top", token: "token-decided", tools: [] },
    ]);
    const stageBinding = await new WorkflowMcpSessionResolver(
      subject.persistence,
    ).resolve("token-decided");
    await subject.coordinator.escalate(stageBinding, {
      escalationId: "decided-choice",
      requestId: "request-sample",
      threadId: "thread-sample",
      questions: sampleEscalationQuestions,
    });
    const pending =
      subject.coordinator.pendingEscalations("instance-decided")[0]!;
    await vi.waitFor(() =>
      expect(
        subject.persistence
          .replayEvents("instance-decided")
          .some(({ type }) => type === "mcp:escalation-adjudication-started"),
      ).toBe(true),
    );

    await subject.coordinator.answerAsSession(
      {
        ...stageBinding,
        adjudication: {
          escalationId: pending.escalationId,
          modelSlug: "sample-capable-model",
          ownerSessionKey: pending.ownerSessionKey,
        },
        sessionKey:
          pending.answeringAuthority.kind === "adjudication"
            ? pending.answeringAuthority.sessionKey
            : "unreachable",
      },
      {
        answers: sampleEscalationAnswer,
        escalationId: pending.escalationId,
        ownerSessionKey: pending.ownerSessionKey,
        prose: "The choice preserves the current epic scope.",
      },
    );

    expect(subject.attentions).toHaveLength(0);
    expect(subject.deliveredAnswers[0]?.answered).toMatchObject({
      answeredBy: { kind: "adjudication" },
      modelSlug: "sample-capable-model",
      prose: "The choice preserves the current epic scope.",
    });
    expect(stopped).toEqual([
      pending.answeringAuthority.kind === "adjudication"
        ? pending.answeringAuthority.sessionKey
        : "unreachable",
    ]);
  });

  it("declines once without shopping for another model and carries reasoning to the operator", async () => {
    let starts = 0;
    const subject = await createEscalationFixture({
      adjudication: {
        start: async () => {
          starts += 1;
          return { modelSlug: "sample-capable-model" };
        },
        stop: async () => undefined,
      },
    });
    createEscalationInstance(subject.persistence, "instance-declined", [
      { sessionKey: "top", token: "token-declined", tools: [] },
    ]);
    const stageBinding = await new WorkflowMcpSessionResolver(
      subject.persistence,
    ).resolve("token-declined");
    await subject.coordinator.escalate(stageBinding, {
      escalationId: "declined-choice",
      requestId: "request-sample",
      threadId: "thread-sample",
      questions: sampleEscalationQuestions,
    });
    const pending =
      subject.coordinator.pendingEscalations("instance-declined")[0]!;
    await vi.waitFor(() => expect(starts).toBe(1));

    await subject.coordinator.declineAdjudication(
      {
        ...stageBinding,
        adjudication: {
          escalationId: pending.escalationId,
          modelSlug: "sample-capable-model",
          ownerSessionKey: pending.ownerSessionKey,
        },
        sessionKey:
          pending.answeringAuthority.kind === "adjudication"
            ? pending.answeringAuthority.sessionKey
            : "unreachable",
      },
      {
        reason: "The choice changes committed product intent.",
        reasoning: "Both options change an operator-reserved outcome.",
      },
    );
    await vi.waitFor(() => expect(subject.notifications).toHaveLength(1));
    await subject.coordinator.replayPendingRoutes();

    expect(starts).toBe(1);
    expect(subject.attentions[0]).toMatchObject({
      adjudication: {
        cause: "The choice changes committed product intent.",
        modelSlug: "sample-capable-model",
        reasoning: "Both options change an operator-reserved outcome.",
      },
      requestId: "request-sample",
      threadId: "thread-sample",
      questions: sampleEscalationQuestions,
    });
  });

  it("fails an adjudicator that attempts another escalation occurrence closed to operator", async () => {
    const subject = await createEscalationFixture({
      adjudication: {
        start: async () => ({ modelSlug: "sample-capable-model" }),
        stop: async () => undefined,
      },
    });
    createEscalationInstance(subject.persistence, "instance-boundary", [
      { sessionKey: "top", token: "token-boundary", tools: [] },
      {
        parentSessionKey: "top",
        sessionKey: "child",
        token: "token-child-boundary",
        tools: [],
      },
    ]);
    const stageBinding = await new WorkflowMcpSessionResolver(
      subject.persistence,
    ).resolve("token-boundary");
    await subject.coordinator.escalate(stageBinding, {
      escalationId: "bound-choice",
      requestId: "request-sample",
      threadId: "thread-sample",
      questions: sampleEscalationQuestions,
    });
    await subject.coordinator.escalate(
      await new WorkflowMcpSessionResolver(subject.persistence).resolve(
        "token-child-boundary",
      ),
      {
        escalationId: "child-choice",
        requestId: "request-sample",
        threadId: "thread-sample",
        questions: sampleEscalationQuestions,
      },
    );
    const pending = subject.coordinator
      .pendingEscalations("instance-boundary")
      .find(({ escalationId }) => escalationId === "bound-choice")!;
    await vi.waitFor(() =>
      expect(
        subject.persistence
          .replayEvents("instance-boundary")
          .some(({ type }) => type === "mcp:escalation-adjudication-started"),
      ).toBe(true),
    );
    const adjudicationBinding = {
      ...stageBinding,
      adjudication: {
        escalationId: pending.escalationId,
        modelSlug: "sample-capable-model",
        ownerSessionKey: pending.ownerSessionKey,
      },
      sessionKey:
        pending.answeringAuthority.kind === "adjudication"
          ? pending.answeringAuthority.sessionKey
          : "unreachable",
    };

    await expect(
      subject.coordinator.answerAsSession(adjudicationBinding, {
        answers: sampleEscalationAnswer,
        escalationId: "child-choice",
        ownerSessionKey: "child",
        prose: "This attempts to answer the child occurrence.",
      }),
    ).rejects.toThrow(/bound escalation occurrence/);
    await vi.waitFor(() => expect(subject.notifications).toHaveLength(1));
    expect(subject.attentions[0]).toMatchObject({
      adjudication: {
        cause: "Adjudication may answer only its bound escalation occurrence",
        modelSlug: "sample-capable-model",
      },
      escalationId: "bound-choice",
    });
    expect(subject.parentEscalations).toHaveLength(1);
    expect(
      subject.coordinator
        .pendingEscalations("instance-boundary")
        .find(({ escalationId }) => escalationId === "child-choice")
        ?.answeringAuthority,
    ).toEqual({ kind: "session", sessionKey: "top" });
  });

  it("fails an adjudication answer naming no offered option closed to operator", async () => {
    const subject = await createEscalationFixture({
      adjudication: {
        start: async () => ({ modelSlug: "sample-capable-model" }),
        stop: async () => undefined,
      },
    });
    createEscalationInstance(subject.persistence, "instance-invalid-choice", [
      {
        sessionKey: "top",
        token: "token-invalid-choice",
        tools: [],
      },
    ]);
    const stageBinding = await new WorkflowMcpSessionResolver(
      subject.persistence,
    ).resolve("token-invalid-choice");
    await subject.coordinator.escalate(stageBinding, {
      escalationId: "invalid-choice",
      requestId: "request-sample",
      threadId: "thread-sample",
      questions: sampleEscalationQuestions,
    });
    const pending = subject.coordinator.pendingEscalations(
      "instance-invalid-choice",
    )[0]!;
    await vi.waitFor(() =>
      expect(
        subject.persistence
          .replayEvents("instance-invalid-choice")
          .some(({ type }) => type === "mcp:escalation-adjudication-started"),
      ).toBe(true),
    );

    await expect(
      subject.coordinator.answerAsSession(
        {
          ...stageBinding,
          adjudication: {
            escalationId: pending.escalationId,
            modelSlug: "sample-capable-model",
            ownerSessionKey: pending.ownerSessionKey,
          },
          sessionKey:
            pending.answeringAuthority.kind === "adjudication"
              ? pending.answeringAuthority.sessionKey
              : "unreachable",
        },
        {
          answers: {
            "delivery-window": {
              selectedOptions: ["Unoffered"],
              text: "",
              reasoning: "Sample reason.",
            },
          },
          escalationId: pending.escalationId,
          ownerSessionKey: pending.ownerSessionKey,
          prose: "The answer does not name an offered option.",
        },
      ),
    ).rejects.toThrow(/does not name an offered option/);
    await vi.waitFor(() => expect(subject.notifications).toHaveLength(1));
    expect(subject.attentions[0]).toMatchObject({
      adjudication: {
        cause: expect.stringMatching(/does not name an offered option/),
        modelSlug: "sample-capable-model",
      },
      escalationId: "invalid-choice",
      requestId: "request-sample",
      threadId: "thread-sample",
      questions: sampleEscalationQuestions,
    });
  });

  it("does not expose an MCP escalate tool", async () => {
    const subject = await createEscalationFixture();
    expect(subject.handler.toolNames.has("escalate")).toBe(false);
    createEscalationInstance(subject.persistence, "instance-description", [
      {
        sessionKey: "top",
        token: "token-description",
        tools: ["advance"],
      },
    ]);
    const client = await connectEscalationClient(
      subject.url,
      "token-description",
      "description-client",
    );

    const catalog = (await client.listTools()).tools;
    expect(catalog.some(({ name }) => name === "advance")).toBe(true);
    const escalation = catalog.find(({ name }) => name === "escalate");
    expect(escalation).toBeUndefined();
  });

  it("rejects advance while the session has a pending escalation", async () => {
    const subject = await createEscalationFixture();
    createEscalationInstance(subject.persistence, "instance-advance", [
      {
        sessionKey: "top",
        token: "token-advance",
        tools: ["advance"],
      },
    ]);
    const client = await connectEscalationClient(
      subject.url,
      "token-advance",
      "advance-client",
    );
    const escalation = await openQuestion(subject, "token-advance", {
      escalationId: "advance-choice",
      requestId: "request-sample",
      threadId: "thread-sample",
      questions: sampleEscalationQuestions,
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
      awaitingAnswer: true,
      escalationId: "advance-choice",
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
        tools: [],
      },
    ]);
    const parent = await connectEscalationClient(
      subject.url,
      "token-parent-advance",
      "parent-advance-client",
    );
    const childCall = await openQuestion(subject, "token-child-advance", {
      escalationId: "child-advance-choice",
      requestId: "request-sample",
      threadId: "thread-sample",
      questions: sampleEscalationQuestions,
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
      awaitingAnswer: true,
      escalationId: "child-advance-choice",
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
    const resumeRelease = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const resumeStart = new Promise<void>((resolve) => {
      resumeStarted = resolve;
    });
    const subject = await createEscalationFixture({
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
        tools: ["advance"],
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

    try {
      await expect(
        openQuestion(subject, "token-race", {
          escalationId: "race-choice",
          questions: sampleEscalationQuestions,
        }),
      ).rejects.toThrow("claimed disposition authority");
    } finally {
      releaseResume();
    }

    await expect(advance).resolves.toMatchObject({
      structuredContent: {
        instanceId: "instance-race",
        status: "completed",
      },
    });
    expect(
      subject.coordinator.pendingEscalations("instance-race"),
    ).toHaveLength(0);
  });

  it("returns a durable receipt immediately and delivers the later top-level answer", async () => {
    const subject = await createEscalationFixture();
    createEscalationInstance(subject.persistence, "instance-top", [
      { sessionKey: "top", token: "token-top", tools: [] },
    ]);

    const call = await openQuestion(subject, "token-top", {
      escalationId: "window-choice",
      requestId: "request-sample",
      threadId: "thread-sample",
      questions: sampleEscalationQuestions,
    });
    await vi.waitFor(() => expect(subject.attentions).toHaveLength(1));

    expect(call).toMatchObject({
      awaitingAnswer: true,
      escalationId: "window-choice",
    });
    expect(subject.attentions[0]).toMatchObject({
      escalationId: "window-choice",
      instanceId: "instance-top",
      ownerSessionKey: "top",
      requestId: "request-sample",
      threadId: "thread-sample",
      questions: sampleEscalationQuestions,
    });
    expect(subject.notifications).toEqual(subject.attentions);
    expect(() =>
      subject.coordinator.requireNoPendingForSession("instance-top", "top"),
    ).toThrow(/pending escalation/);
    await expect(
      openQuestion(subject, "token-top", {
        escalationId: "window-choice",
        questions: [
          {
            ...sampleEscalationQuestions[0],
            question: "Which later delivery window should be used?",
          },
        ],
      }),
    ).rejects.toThrow("retried with different questions");

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
        answers: {
          "delivery-window": {
            selectedOptions: ["wait"],
            text: "",
            reasoning: "Sample reason.",
          },
        },
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

  it("requires reasoning and carries a zero-option text answer into its delivered turn", async () => {
    const subject = await createEscalationFixture();
    createEscalationInstance(subject.persistence, "instance-value", [
      { sessionKey: "top", token: "token-value", tools: [] },
    ]);
    await openQuestion(subject, "token-value", {
      escalationId: "reference-value",
      questions: [
        {
          id: "reference",
          multiSelect: false,
          options: [],
          question: "Which sample reference should be used?",
        },
      ],
    });

    const answer = {
      escalationId: "reference-value",
      instanceId: "instance-value",
      ownerSessionKey: "top",
    };
    await expect(
      subject.coordinator.answerAsOperator({
        ...answer,
        answers: {
          reference: { selectedOptions: [], text: "A12", reasoning: "" },
        },
      }),
    ).rejects.toThrow();
    await subject.coordinator.answerAsOperator({
      ...answer,
      answers: {
        reference: {
          selectedOptions: [],
          text: "AB12",
          reasoning: "Matches the sample label.",
        },
      },
      prose: "Use this reference for the current sample.",
    });

    expect(subject.deliveredAnswers).toHaveLength(1);
    expect(subject.deliveredAnswers[0]?.message).toContain("Answer: AB12");
    expect(subject.deliveredAnswers[0]?.message).toContain(
      "Matches the sample label.",
    );
    expect(subject.deliveredAnswers[0]?.message).toContain(
      "Additional context: Use this reference for the current sample.",
    );
  });

  it("allows only a parent correlation token to answer its child", async () => {
    const subject = await createEscalationFixture();
    createEscalationInstance(subject.persistence, "instance-family", [
      { sessionKey: "parent", token: "token-parent", tools: ["answer"] },
      {
        parentSessionKey: "parent",
        sessionKey: "child",
        token: "token-child",
        tools: [],
      },
      { sessionKey: "peer", token: "token-peer", tools: ["answer"] },
    ]);
    const parent = await connectEscalationClient(
      subject.url,
      "token-parent",
      "parent-client",
    );
    const peer = await connectEscalationClient(
      subject.url,
      "token-peer",
      "peer-client",
    );

    const childCall = openQuestion(subject, "token-child", {
      escalationId: "child-choice",
      requestId: "request-sample",
      threadId: "thread-sample",
      questions: sampleEscalationQuestions,
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
      awaitingAnswer: true,
      escalationId: "child-choice",
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
        tools: [],
      },
      {
        sessionKey: "adjudicator",
        token: "token-adjudicator",
        tools: ["answer"],
      },
    ]);
    const adjudicator = await connectEscalationClient(
      subject.url,
      "token-adjudicator",
      "adjudicator-client",
    );
    await openQuestion(subject, "token-child-delegated", {
      escalationId: "delegated-choice",
      requestId: "request-sample",
      threadId: "thread-sample",
      questions: sampleEscalationQuestions,
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
        tools: [],
      },
    ]);
    await openQuestion(subject, "token-child-handback", {
      escalationId: "handback-choice",
      requestId: "request-sample",
      threadId: "thread-sample",
      questions: sampleEscalationQuestions,
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
      { sessionKey: "top", token: "token-replay", tools: [] },
    ]);
    const binding = await new WorkflowMcpSessionResolver(
      subject.persistence,
    ).resolve("token-replay");
    const escalationId = "e".repeat(128);
    await expect(
      subject.coordinator.escalate(binding, {
        escalationId,
        requestId: "request-sample",
        threadId: "thread-sample",
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
      "mcp:escalation-delivery-completed",
      "mcp:escalation-decision-recorded",
    ]);
    recoveredPersistence.close();
  });

  it("delivers before retrying a failed decision log without duplicating the turn", async () => {
    const subject = await createEscalationFixture();
    createEscalationInstance(subject.persistence, "instance-decision-retry", [
      {
        sessionKey: "top",
        token: "token-decision-retry",
        tools: [],
      },
    ]);
    const binding = await new WorkflowMcpSessionResolver(
      subject.persistence,
    ).resolve("token-decision-retry");
    let decisionLogAvailable = false;
    const delivery = vi.fn(async () => undefined);
    const decisionLog = vi.fn(async () => {
      if (!decisionLogAvailable) throw new Error("Sample decision log failed");
    });
    const coordinator = new EscalationCoordinator({
      attention: { raise: async () => undefined },
      decisionLog: { record: decisionLog },
      delivery: { deliver: delivery },
      persistence: subject.persistence,
      pushover: { send: async () => undefined },
      session: { steer: async () => undefined },
    });

    await coordinator.escalate(binding, {
      escalationId: "decision-retry",
      requestId: "request-sample",
      threadId: "thread-sample",
      questions: sampleEscalationQuestions,
    });
    await expect(
      coordinator.answerAsOperator({
        answers: sampleEscalationAnswer,
        escalationId: "decision-retry",
        instanceId: "instance-decision-retry",
        ownerSessionKey: "top",
      }),
    ).rejects.toThrow("Sample decision log failed");
    expect(delivery).toHaveBeenCalledTimes(1);

    decisionLogAvailable = true;
    await coordinator.replayPendingDeliveries();
    expect(delivery).toHaveBeenCalledTimes(1);
    expect(decisionLog).toHaveBeenCalledTimes(2);
  });

  it("contains one replay settlement failure and continues other instances", async () => {
    const subject = await createEscalationFixture();
    for (const instanceId of [
      "instance-settlement-a",
      "instance-settlement-b",
    ]) {
      createEscalationInstance(subject.persistence, instanceId, [
        {
          sessionKey: `session-${instanceId.at(-1)}`,
          token: `token-${instanceId.at(-1)}`,
          tools: [],
        },
      ]);
    }
    const contained: string[] = [];
    const delivered: string[] = [];
    const coordinator = new EscalationCoordinator({
      attention: { raise: async () => undefined },
      containSettlementFailure: async (_error, opened) => {
        contained.push(opened.instanceId);
        return true;
      },
      decisionLog: { record: async () => undefined },
      delivery: {
        deliver: async ({ opened }) => {
          if (opened.instanceId.endsWith("-a")) {
            throw new Error("Sample permanent delivery failure");
          }
          delivered.push(opened.instanceId);
        },
      },
      persistence: subject.persistence,
      pushover: { send: async () => undefined },
      session: { steer: async () => undefined },
    });
    for (const [instanceId, sessionKey, token] of [
      ["instance-settlement-a", "session-a", "token-a"],
      ["instance-settlement-b", "session-b", "token-b"],
    ] as const) {
      await coordinator.escalate(
        await new WorkflowMcpSessionResolver(subject.persistence).resolve(
          token,
        ),
        {
          escalationId: "settlement-replay",
          requestId: "request-sample",
          threadId: "thread-sample",
          questions: sampleEscalationQuestions,
        },
      );
      subject.persistence.appendEvent(instanceId, "mcp:escalation-answered", {
        answeredBy: { kind: "operator" },
        answers: sampleEscalationAnswer,
        escalationId: "settlement-replay",
        ownerSessionKey: sessionKey,
      });
    }

    await expect(
      coordinator.replayPendingDeliveries(),
    ).resolves.toBeUndefined();
    expect(contained).toEqual(["instance-settlement-a"]);
    expect(delivered).toEqual(["instance-settlement-b"]);
  });

  it("uses distinct delivery identities when an escalation ID recurs in a later session", async () => {
    const subject = await createEscalationFixture();
    createEscalationInstance(subject.persistence, "instance-recurrence", [
      { sessionKey: "first", token: "token-first", tools: [] },
      { sessionKey: "second", token: "token-second", tools: [] },
    ]);
    const resolver = new WorkflowMcpSessionResolver(subject.persistence);
    for (const [sessionKey, token] of [
      ["first", "token-first"],
      ["second", "token-second"],
    ] as const) {
      await subject.coordinator.escalate(await resolver.resolve(token), {
        escalationId: "repeated-choice",
        requestId: "request-sample",
        threadId: "thread-sample",
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
        tools: [],
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
          requestId: "request-sample",
          threadId: "thread-sample",
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
      { sessionKey: "top", token: "token-legacy", tools: [] },
    ]);
    subject.persistence.appendEvent(
      "instance-legacy-answer",
      "mcp:escalation-opened",
      {
        attentionId: "attention-legacy-answer",
        escalationId: "legacy-choice",
        openedAt: "2026-01-01T00:00:00.000Z",
        ownerSessionKey: "top",
        requestId: "request-sample",
        threadId: "thread-sample",
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
      { sessionKey: "top", token: "token-invalid", tools: [] },
    ]);
    const binding = await new WorkflowMcpSessionResolver(
      subject.persistence,
    ).resolve("token-invalid");
    await subject.coordinator.escalate(binding, {
      escalationId: "invalid-choice",
      requestId: "request-sample",
      threadId: "thread-sample",
      questions: sampleEscalationQuestions,
    });
    await vi.waitFor(() => expect(subject.attentions).toHaveLength(1));

    subject.persistence.appendEvent(
      "instance-invalid-answer",
      "mcp:escalation-answered",
      {
        answeredBy: { kind: "operator" },
        answers: {
          "delivery-window": {
            selectedOptions: ["Unoffered"],
            text: "",
            reasoning: "Sample reason.",
          },
        },
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
      { sessionKey: "top", token: "token-answer-first", tools: [] },
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
        requestId: "request-sample",
        threadId: "thread-sample",
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
        tools: [],
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
        requestId: "request-sample",
        threadId: "thread-sample",
        questions: sampleEscalationQuestions,
        stage: "assess",
      },
    );
    for (const answers of [
      sampleEscalationAnswer,
      {
        "delivery-window": {
          selectedOptions: ["wait"],
          text: "",
          reasoning: "Sample reason.",
        },
      },
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
