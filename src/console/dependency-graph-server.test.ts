import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BoardTask } from "../board-adapter/index.js";
import { consoleAttentionFingerprint } from "./attention-contract.js";
import { createConsoleServer } from "./server.js";
import type { ConsoleBoard, ConsoleStateSource } from "./types.js";

class GraphBoard implements ConsoleBoard {
  async readBoard(): Promise<BoardTask[]> {
    return [
      {
        blocked: false,
        dependencies: [],
        id: 31,
        priority: "medium",
        status: "in-progress",
        tags: ["type:epic"],
        title: "Example group",
      },
      {
        blocked: false,
        dependencies: [31],
        id: 32,
        parent: 31,
        priority: "medium",
        status: "todo",
        tags: [],
        title: "Example item",
      },
    ];
  }

  async readBoardStatuses(): Promise<string[]> {
    return ["todo", "in-progress", "done"];
  }

  async setEpicInProgress(): Promise<void> {
    throw new Error("unexpected write");
  }
}

const correlationToken = "correlation-token-dependency-http";
const attentionState = {
  actions: [],
  attentionId: "attention-31",
  futurePrivateField: `future-${correlationToken}`,
  kind: "stale-instance",
  message: `A record carrying ${correlationToken} requires inspection`,
  scope: "task:31" as const,
  taskId: 31,
};

const state: ConsoleStateSource = {
  listAttention: async () => [
    {
      ...attentionState,
      fingerprint: consoleAttentionFingerprint(attentionState),
    },
  ],
  listCorrelationTokens: async () => [correlationToken],
  listEvents: async () => [],
  listInstances: async () => [],
  readLifecycle: async ({ taskId }) => ({
    blueprint: {
      blobHash: "b".repeat(40),
      edges: [],
      id: "sample-lifecycle",
      nodes: [{ id: "inspect", uses: "wait" }],
      path: "blueprints/sample-lifecycle.json",
    },
    currentStageIds: ["inspect"],
    events: [],
    instanceId: `instance-${taskId}`,
    nextSequence: 0,
    status: "awaiting",
    taskId,
  }),
};

describe("dependency graph server route", () => {
  let baseUrl: string;
  let server: ReturnType<typeof createConsoleServer>;

  beforeEach(async () => {
    server = createConsoleServer({ board: new GraphBoard(), state });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    );
  });

  it("serves token-free attention treatment through the real HTTP route", async () => {
    const response = await globalThis.fetch(
      `${baseUrl}/api/dependency-graph?scope=epic:31`,
    );
    const serialized = await response.text();
    const graph = JSON.parse(serialized) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(graph).toMatchObject({
      edges: [{ from: 31, to: 32, trace: true }],
      nodes: [
        expect.objectContaining({ id: 31, treatment: "attention" }),
        expect.objectContaining({ id: 32, treatment: "blocked" }),
      ],
      scope: { epicId: 31, kind: "epic" },
    });
    expect(serialized).not.toContain(correlationToken);
    expect(serialized).not.toContain("futurePrivateField");
    await expect(
      globalThis.fetch(`${baseUrl}/api/dependency-graph?scope=all`, {
        method: "POST",
      }),
    ).resolves.toMatchObject({ status: 405 });
  });
});
