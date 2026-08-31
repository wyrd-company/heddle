// ---
// relationships:
//   verifies: heddle
// ---

import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupEscalationFixtures,
  connectEscalationClient,
  createEscalationFixture,
  createEscalationInstance,
  sampleEscalationAnswer,
  sampleEscalationQuestions,
} from "../mcp-server/escalation-tools.test-support.js";
import { createConsoleAttention } from "./attention-contract.js";
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

  it("releases a blocked MCP escalation through its offered console action", async () => {
    const subject = await createEscalationFixture();
    createEscalationInstance(subject.persistence, "instance-sample", [
      {
        sessionKey: "sample-session",
        token: "sample-token",
        tools: ["escalate"],
      },
    ]);
    const client = await connectEscalationClient(
      subject.url,
      "sample-token",
      "sample-client",
    );
    let settled = false;
    const blocked = client
      .callTool({
        arguments: {
          escalationId: "sample-choice",
          questions: sampleEscalationQuestions,
        },
        name: "escalate",
      })
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(subject.attentions).toHaveLength(1));
    expect(settled).toBe(false);

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
            questions: raised.questions.map((question) => ({
              id: question.id,
              multiSelect: false,
              options: question.options.map((option) => ({
                description: option.description,
                label: option.label,
                value: option.id,
              })),
              prompt: question.prompt,
            })),
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
          subject.coordinator.answerAsOperator({
            answers: answers as Record<string, string>,
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
    await expect(blocked).resolves.toMatchObject({
      structuredContent: {
        answers: sampleEscalationAnswer,
        escalationId: "sample-choice",
      },
    });
    expect(current).toEqual([]);
    expect(subject.coordinator.pendingEscalations("instance-sample")).toEqual(
      [],
    );
  });
});
