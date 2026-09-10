// ---
// relationships:
//   verifies: heddle
// ---

import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupEscalationFixtures,
  createEscalationFixture,
  createEscalationInstance,
  sampleEscalationAnswer,
  sampleEscalationQuestions,
} from "../mcp-server/escalation-tools.test-support.js";
import { createConsoleAttention } from "./attention-contract.js";
import { WorkflowMcpSessionResolver } from "../mcp-server/session-binding.js";
import { createConsoleServer } from "./server.js";
import type {
  ConsoleAttention,
  ConsoleBoard,
  ConsoleStateSource,
} from "./types.js";

const board: ConsoleBoard = {
  readBoard: async () => [],
  readBoardStatuses: async () => [],
  setEpicInProgress: async () => undefined,
};

describe("console escalation disposition", () => {
  let server: ReturnType<typeof createConsoleServer> | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
      server = undefined;
    }
    await cleanupEscalationFixtures();
  });

  it("answers a harness question through its offered console action", async () => {
    const subject = await createEscalationFixture();
    createEscalationInstance(subject.persistence, "instance-sample", [
      {
        sessionKey: "sample-session",
        token: "sample-token",
        tools: [],
      },
    ]);
    const receipt = await subject.coordinator.escalate(
      await new WorkflowMcpSessionResolver(subject.persistence).resolve(
        "sample-token",
      ),
      {
        escalationId: "sample-choice",
        questions: sampleEscalationQuestions,
        requestId: "request-sample",
        threadId: "thread-sample",
      },
    );
    await vi.waitFor(() => expect(subject.attentions).toHaveLength(1));
    expect(receipt).toMatchObject({
      awaitingAnswer: true,
      escalationId: "sample-choice",
    });

    const raised = subject.attentions[0]!;
    const entry = createConsoleAttention({
      actions: [
        {
          actionId: "answer",
          contract: {
            escalationId: raised.escalationId,
            instanceId: raised.instanceId,
            kind: "escalation.answer",
            ownerSessionKey: raised.ownerSessionKey,
          },
          input: {
            kind: "questions",
            questions: raised.questions,
          },
          label: "Answer escalation",
        },
      ],
      attentionId: raised.attentionId,
      instanceId: raised.instanceId,
      kind: "escalation",
      message: raised.message,
      scope: "task:41",
      taskId: 41,
    });
    let current: ConsoleAttention[] = [entry];
    const state: ConsoleStateSource = {
      listAttention: async () => current,
      listCorrelationTokens: async () => [],
      listEvents: async () => [],
      listInstances: async () => [],
      readLifecycle: async () => {
        throw new Error("unexpected lifecycle read");
      },
    };
    server = createConsoleServer({
      actions: {
        execute: async ({ action, answers }) => {
          if (action.contract.kind !== "escalation.answer") {
            throw new Error("unexpected console action authority");
          }
          await subject.coordinator.answerAsOperator({
            answers: answers!,
            escalationId: action.contract.escalationId,
            instanceId: action.contract.instanceId,
            ownerSessionKey: action.contract.ownerSessionKey,
          });
          current = [];
        },
      },
      board,
      state,
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;

    const response = await globalThis.fetch(
      `http://127.0.0.1:${port}/api/attention/${entry.attentionId}/actions/answer`,
      {
        body: JSON.stringify({
          answers: sampleEscalationAnswer,
          fingerprint: entry.fingerprint,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );

    expect(response.status).toBe(204);
    expect(subject.deliveredAnswers).toHaveLength(1);
    expect(current).toEqual([]);
    expect(subject.coordinator.pendingEscalations("instance-sample")).toEqual(
      [],
    );
  });
});
