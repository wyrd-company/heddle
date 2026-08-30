// ---
// relationships:
//   verifies: heddle
// ---

import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqlitePersistence } from "../persistence/index.js";
import type { ConsoleBoard } from "../console/index.js";
import {
  createProductionComposition,
  type ProductionComposition,
} from "../production/index.js";
import {
  prepareProductionFixture,
  SyntheticT3,
} from "../production/composition.test-support.js";
import {
  startHeddleServer,
  startHeddleServerFromEnvironment,
  type HeddleDeploymentServer,
} from "./server.js";

const availablePort = async (): Promise<number> => {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test HTTP server did not bind a TCP port");
  }
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
};

describe("deployed Heddle service", () => {
  let directory = "";
  let production: ProductionComposition | undefined;
  let service: HeddleDeploymentServer | undefined;
  const board: ConsoleBoard = {
    readBoard: async () => [
      {
        blocked: false,
        dependencies: [],
        id: 101,
        priority: "medium",
        status: "in-progress",
        tags: [],
        title: "Sample Record",
      },
    ],
    readBoardStatuses: async () => ["todo", "in-progress", "done"],
    setEpicInProgress: async () => undefined,
  };

  afterEach(async () => {
    await service?.close();
    await production?.close();
    if (directory) await rm(directory, { force: true, recursive: true });
  });

  it("serves the console, recovered instances, and the MCP endpoint", async () => {
    directory = await mkdtemp(join(tmpdir(), "heddle-deployment-server-"));
    const writer = new SqlitePersistence({ stateDirectory: directory });
    writer.createInstance("task-101", {
      correlationTokens: {},
      flowcraftContext: { awaitingNodeIds: ["inspect"] },
      handoffs: [],
      todoState: null,
    });
    writer.close();

    service = await startHeddleServerFromEnvironment(
      {
        HEDDLE_HOST: "127.0.0.1",
        HEDDLE_PORT: "0",
        HEDDLE_STATE_PATH: directory,
      },
      {
        blueprintEditor: {
          load: async (artifactId) => ({
            blobHash: "a".repeat(40),
            blueprint: { edges: [], id: artifactId, nodes: [] },
            path: `blueprints/${artifactId}.json`,
            positions: {},
          }),
          save: async () => {
            throw new Error("not used");
          },
        },
        board,
      },
    );
    const origin = `http://127.0.0.1:${service.port}`;

    const consoleResponse = await globalThis.fetch(origin);
    expect(consoleResponse.status).toBe(200);
    await expect(consoleResponse.text()).resolves.toContain(
      "<title>Heddle Console</title>",
    );

    const instances = await globalThis.fetch(`${origin}/api/instances`);
    await expect(instances.json()).resolves.toMatchObject([
      { instanceId: "task-101", stageId: "inspect", taskId: 101 },
    ]);

    const projection = await globalThis.fetch(`${origin}/api/projection`);
    const projected = (await projection.json()) as {
      columns: Array<{ tasks: Array<{ id: number; stageId?: string }> }>;
    };
    expect(projected.columns.flatMap(({ tasks }) => tasks)).toContainEqual(
      expect.objectContaining({ id: 101, stageId: "inspect" }),
    );

    const blueprint = await globalThis.fetch(
      `${origin}/api/blueprints/sample-process`,
    );
    expect(blueprint.status).toBe(200);
    await expect(blueprint.json()).resolves.toMatchObject({
      blueprint: { id: "sample-process" },
      path: "blueprints/sample-process.json",
    });

    const mcp = await globalThis.fetch(`${origin}/mcp`, { method: "POST" });
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("www-authenticate")).toBe("Bearer");

    const oversized = await globalThis.fetch(`${origin}/mcp`, {
      body: new Uint8Array(1024 * 1024 + 1),
      method: "POST",
    });
    expect(oversized.status).toBe(413);
  });

  it.each([
    [{ HEDDLE_PORT: "3774" }, "HEDDLE_STATE_PATH must not be empty"],
    [
      { HEDDLE_PORT: "70000", HEDDLE_STATE_PATH: "/tmp/example" },
      "HEDDLE_PORT must be between 0 and 65535",
    ],
    [
      {
        HEDDLE_BOARD_PATH: "relative/board",
        HEDDLE_PORT: "3774",
        HEDDLE_STATE_PATH: "/tmp/example",
      },
      "HEDDLE_BOARD_PATH must be an absolute path",
    ],
  ])("rejects invalid deployment configuration %#", async (input, expected) => {
    await expect(startHeddleServerFromEnvironment(input)).rejects.toThrow(
      expected,
    );
  });

  it("uses one production owner for scheduling, board, state, and shutdown", async () => {
    const fixture = await prepareProductionFixture();
    directory = fixture.root;
    const t3 = new SyntheticT3();
    production = createProductionComposition({
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: async () => undefined },
      t3,
    });
    await expect(
      startHeddleServerFromEnvironment(
        { HEDDLE_HOST: "127.0.0.1", HEDDLE_PORT: "0" },
        { board, production },
      ),
    ).rejects.toThrow(
      "A production composition owns its board and console state boundaries",
    );
    await expect(
      startHeddleServerFromEnvironment(
        { HEDDLE_HOST: "127.0.0.1", HEDDLE_PORT: "0" },
        {
          blueprintEditor: {
            load: async () => {
              throw new Error("not used");
            },
            save: async () => {
              throw new Error("not used");
            },
          },
          production,
        },
      ),
    ).rejects.toThrow(
      "A production composition owns its board and console state boundaries",
    );
    await expect(
      startHeddleServerFromEnvironment(
        { HEDDLE_HOST: "127.0.0.1", HEDDLE_PORT: "0" },
        {
          consoleActions: { execute: async () => undefined },
          production,
        },
      ),
    ).rejects.toThrow(
      "A production composition owns its board and console state boundaries",
    );
    service = await startHeddleServer(
      { host: "127.0.0.1", port: 0 },
      { production },
    );

    const response = await globalThis.fetch(
      `http://127.0.0.1:${service.port}/api/instances`,
    );
    await expect(response.json()).resolves.toMatchObject([
      { instanceId: `task-${fixture.taskId}`, taskId: fixture.taskId },
    ]);
    const runtime = production.persistence.listReconcilerRuntime()[0]!;
    await production.attention.raise({
      attentionId: "approval-attention",
      instanceId: runtime.instanceId,
      kind: "approval",
      message: "Approval required",
      requestId: "approval-one",
      sessionKey: runtime.sessionKey!,
      threadId: runtime.threadId!,
    });
    const attentionResponse = await globalThis.fetch(
      `http://127.0.0.1:${service.port}/api/attention`,
    );
    const attention = (await attentionResponse.json()) as Array<{
      actions: Array<{ actionId: string }>;
      attentionId: string;
      fingerprint: string;
    }>;
    const entry = attention[0]!;
    const action = entry.actions[0]!;
    const actionResponse = await globalThis.fetch(
      `http://127.0.0.1:${service.port}/api/attention/${entry.attentionId}/actions/${action.actionId}`,
      {
        body: JSON.stringify({ fingerprint: entry.fingerprint }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    expect(actionResponse.status).toBe(204);
    expect(t3.approvalResponses).toEqual([
      {
        commandId: "approval-attention",
        decision: "accept",
        requestId: "approval-one",
        threadId: runtime.threadId,
      },
    ]);
    await expect(
      globalThis
        .fetch(`http://127.0.0.1:${service.port}/api/attention`)
        .then((result) => result.json()),
    ).resolves.toEqual([]);
    const lifecycle = await globalThis.fetch(
      `http://127.0.0.1:${service.port}/api/lifecycle?task=${fixture.taskId}&after=0`,
    );
    expect(lifecycle.status).toBe(200);
    await expect(lifecycle.json()).resolves.toMatchObject({
      currentStageIds: ["implement"],
      instanceId: `task-${fixture.taskId}`,
      taskId: fixture.taskId,
    });
    const blueprint = await globalThis.fetch(
      `http://127.0.0.1:${service.port}/api/blueprints/sample`,
    );
    expect(blueprint.status).toBe(200);
    await expect(blueprint.json()).resolves.toMatchObject({
      blueprint: { id: "sample" },
      path: "blueprints/sample.json",
    });
    const unavailableLifecycle = await globalThis.fetch(
      `http://127.0.0.1:${service.port}/api/lifecycle?task=999&after=0`,
    );
    expect(unavailableLifecycle.status).toBe(503);
    expect(() =>
      createProductionComposition({
        configuration: fixture.configuration,
        providerUsage: {
          readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
        },
        pushoverTransport: { send: async () => undefined },
        t3: new SyntheticT3(),
      }),
    ).toThrow("A production composition already owns");

    await service.close();
    service = undefined;
    production = undefined;
    const replacement = createProductionComposition({
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: async () => undefined },
      t3: new SyntheticT3(),
    });
    await replacement.close();
  });

  it("keeps the bound endpoint unready until production startup completes", async () => {
    const fixture = await prepareProductionFixture();
    directory = fixture.root;
    production = createProductionComposition({
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: async () => undefined },
      t3: new SyntheticT3(),
    });
    const originalStart = production.start;
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    production.start = async () => {
      await startGate;
      await originalStart();
    };
    const port = await availablePort();
    const starting = startHeddleServer(
      { host: "127.0.0.1", port },
      { production },
    );
    let startingResponse: globalThis.Response | undefined;
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          startingResponse = await globalThis.fetch(
            `http://127.0.0.1:${port}/api/instances`,
          );
          break;
        } catch {
          await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
        }
      }
      expect(startingResponse?.status).toBe(503);
      await expect(startingResponse?.json()).resolves.toEqual({
        error: "Heddle service is starting",
      });
    } finally {
      releaseStart();
      service = await starting;
    }

    const ready = await globalThis.fetch(
      `http://127.0.0.1:${port}/api/instances`,
    );
    expect(ready.status).toBe(200);
  });

  it("rejects simultaneous production instance and factory authorities", async () => {
    const fixture = await prepareProductionFixture();
    directory = fixture.root;
    production = createProductionComposition({
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: async () => undefined },
      t3: new SyntheticT3(),
    });

    await expect(
      startHeddleServer(
        { host: "127.0.0.1", port: 0 },
        { production, productionFactory: () => production! },
      ),
    ).rejects.toThrow(
      "A production composition and production factory cannot both be supplied",
    );
  });
});
