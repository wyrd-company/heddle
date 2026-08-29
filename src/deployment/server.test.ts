// ---
// relationships:
//   verifies: heddle
// ---

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqlitePersistence } from "../persistence/index.js";
import {
  startHeddleServerFromEnvironment,
  type HeddleDeploymentServer,
} from "./server.js";

describe("deployed Heddle service", () => {
  let directory = "";
  let service: HeddleDeploymentServer | undefined;

  afterEach(async () => {
    await service?.close();
    if (directory) await rm(directory, { force: true, recursive: true });
  });

  it("serves the console, recovered instances, and the MCP endpoint", async () => {
    directory = await mkdtemp(join(tmpdir(), "heddle-deployment-server-"));
    const writer = new SqlitePersistence({ stateDirectory: directory });
    writer.createInstance("sample-instance", {
      correlationTokens: {},
      flowcraftContext: { stage: "inspect" },
      handoffs: [],
      todoState: null,
    });
    writer.close();

    service = await startHeddleServerFromEnvironment({
      HEDDLE_HOST: "127.0.0.1",
      HEDDLE_PORT: "0",
      HEDDLE_STATE_PATH: directory,
    });
    const origin = `http://127.0.0.1:${service.port}`;

    const consoleResponse = await globalThis.fetch(origin);
    expect(consoleResponse.status).toBe(200);
    await expect(consoleResponse.text()).resolves.toContain(
      'data-instance-count="1"',
    );

    const instances = await globalThis.fetch(`${origin}/api/instances`);
    await expect(instances.json()).resolves.toMatchObject({
      instances: [{ instanceId: "sample-instance", version: 1 }],
    });

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
  ])("rejects invalid deployment configuration %#", async (input, expected) => {
    await expect(startHeddleServerFromEnvironment(input)).rejects.toThrow(
      expected,
    );
  });
});
