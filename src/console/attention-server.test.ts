// ---
// relationships:
//   validates: heddle
// ---

import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createConsoleAttention } from "./attention-contract.js";
import { createConsoleServer } from "./server.js";
import type {
  ConsoleAttention,
  ConsoleAttentionActionPort,
  ConsoleBoard,
  ConsoleStateSource,
} from "./types.js";

const board: ConsoleBoard = {
  readBoard: async () => [],
  readBoardStatuses: async () => [],
  setEpicInProgress: async () => undefined,
};

const actionable = (message = "A delivery choice is required") =>
  createConsoleAttention({
    actions: [
      {
        actionId: "answer",
        contract: {
          escalationId: "sample-choice",
          instanceId: "instance-12",
          kind: "escalation.answer" as const,
          ownerSessionKey: "session-12",
        },
        input: {
          kind: "questions" as const,
          questions: [
            {
              id: "delivery-window",
              multiSelect: false,
              options: [
                { label: "Continue", value: "continue" },
                { label: "Wait", value: "wait" },
              ],
              prompt: "Which delivery window should be used?",
            },
          ],
        },
        label: "Answer escalation",
      },
    ],
    attentionId: "attention-12",
    instanceId: "instance-12",
    kind: "escalation",
    message,
    scope: "task:12" as const,
    taskId: 12,
  });

const state = (read: () => ConsoleAttention[]): ConsoleStateSource => ({
  listAttention: async () => read(),
  listEvents: async () => [],
  listInstances: async () => [],
  readLifecycle: async () => {
    throw new Error("unexpected lifecycle read");
  },
});

describe("console attention action endpoint", () => {
  let server: ReturnType<typeof createConsoleServer> | undefined;

  afterEach(async () => {
    if (server === undefined) return;
    await new Promise<void>((resolve, reject) =>
      server!.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    );
  });

  const start = async (
    attention: () => ConsoleAttention[],
    actions?: ConsoleAttentionActionPort,
  ): Promise<string> => {
    server = createConsoleServer({
      ...(actions === undefined ? {} : { actions }),
      board,
      state: state(attention),
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  it("re-reads the current offer and delegates its exact authority target", async () => {
    const current = actionable();
    const execute = vi.fn<ConsoleAttentionActionPort["execute"]>(
      async () => undefined,
    );
    const baseUrl = await start(() => [current], { execute });

    const response = await globalThis.fetch(
      `${baseUrl}/api/attention/attention-12/actions/answer`,
      {
        body: JSON.stringify({
          answers: { "delivery-window": "continue" },
          fingerprint: current.fingerprint,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );

    expect(response.status).toBe(204);
    expect(execute).toHaveBeenCalledWith({
      action: current.actions[0],
      answers: { "delivery-window": "continue" },
      attention: current,
    });
  });

  it("rejects a stale fingerprint before calling the action port", async () => {
    const shown = actionable();
    const current = actionable("A superseding delivery choice is required");
    const execute = vi.fn<ConsoleAttentionActionPort["execute"]>(
      async () => undefined,
    );
    const baseUrl = await start(() => [current], { execute });

    const response = await globalThis.fetch(
      `${baseUrl}/api/attention/attention-12/actions/answer`,
      {
        body: JSON.stringify({
          answers: { "delivery-window": "continue" },
          fingerprint: shown.fingerprint,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );

    expect(response.status).toBe(409);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an unoffered action and answer before calling the action port", async () => {
    const current = actionable();
    const execute = vi.fn<ConsoleAttentionActionPort["execute"]>(
      async () => undefined,
    );
    const baseUrl = await start(() => [current], { execute });
    const request = (actionId: string, answer: string) =>
      globalThis.fetch(
        `${baseUrl}/api/attention/attention-12/actions/${actionId}`,
        {
          body: JSON.stringify({
            answers: { "delivery-window": answer },
            fingerprint: current.fingerprint,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );

    await expect(request("dismiss", "continue")).resolves.toMatchObject({
      status: 409,
    });
    await expect(request("answer", "later")).resolves.toMatchObject({
      status: 400,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not expose actionable attention without an injected action port", async () => {
    const baseUrl = await start(() => [actionable()]);

    await expect(
      globalThis.fetch(`${baseUrl}/api/attention`),
    ).resolves.toMatchObject({
      status: 503,
    });
  });
});
