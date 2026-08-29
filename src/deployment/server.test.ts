// ---
// relationships:
//   verifies: heddle
// ---

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqlitePersistence } from "../persistence/index.js";
import type { ConsoleBoard } from "../console/index.js";
import {
  startHeddleServerFromEnvironment,
  type HeddleDeploymentServer,
} from "./server.js";

describe("deployed Heddle service", () => {
  let directory = "";
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
      { board },
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

    const mcp = await globalThis.fetch(`${origin}/mcp`, { method: "POST" });
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("www-authenticate")).toBe("Bearer");
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
});
