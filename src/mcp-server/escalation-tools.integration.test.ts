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
    const abandoned = subject.coordinator.escalate(
      binding,
      {
        escalationId: "restart-choice",
        questions: sampleEscalationQuestions,
      },
      abort.signal,
    );
    await vi.waitFor(() => expect(subject.attentions).toHaveLength(1));
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
        escalationId: "restart-choice",
        ownerSessionKey: "top",
      },
    ]);
    recovered.answerAsOperator({
      answers: sampleEscalationAnswer,
      escalationId: "restart-choice",
      instanceId: "instance-replay",
      ownerSessionKey: "top",
    });
    const recoveredBinding = await new WorkflowMcpSessionResolver(
      recoveredPersistence,
    ).resolve("token-replay");
    await expect(
      recovered.escalate(recoveredBinding, {
        escalationId: "restart-choice",
        questions: sampleEscalationQuestions,
      }),
    ).resolves.toEqual({
      answers: sampleEscalationAnswer,
      escalationId: "restart-choice",
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
});
