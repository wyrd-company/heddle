// ---
// relationships:
//   verifies: heddle
// ---

import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { readLifecycleContext } from "../engine/index.js";
import { SqlitePersistence } from "../persistence/index.js";
import type { ConsoleBoard } from "../console/index.js";
import {
  createProductionComposition,
  type ProductionComposition,
} from "../production/index.js";
import {
  prepareProductionFixture,
  execute,
  SyntheticT3,
  type ProductionFixture,
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
  const clients: Client[] = [];
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
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await service?.close();
    await production?.close();
    if (directory) await rm(directory, { force: true, recursive: true });
  });

  const enableBlockedReportTool = async (
    fixture: ProductionFixture,
  ): Promise<void> => {
    const path = join(
      fixture.blueprintsRepositoryRoot,
      "blueprints",
      "sample.json",
    );
    const artifact = JSON.parse(await readFile(path, "utf8")) as {
      nodes: Array<{ id: string; tools?: string[] }>;
    };
    const implement = artifact.nodes.find(({ id }) => id === "implement");
    if (implement?.tools === undefined) {
      throw new Error("fixture implement stage has no tool catalog");
    }
    implement.tools.push("report_blocked");
    await writeFile(path, JSON.stringify(artifact));
    await execute("git", ["add", "blueprints/sample.json"], {
      cwd: fixture.blueprintsRepositoryRoot,
    });
    await execute(
      "git",
      [
        "-c",
        "user.name=Fixture User",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Enable blocked report fixture",
      ],
      { cwd: fixture.blueprintsRepositoryRoot },
    );
    await execute("git", ["push", "--quiet", "origin", "main"], {
      cwd: fixture.blueprintsRepositoryRoot,
    });
  };

  const startDisclosureFixture = async (input?: {
    reportBlocked?: boolean;
  }) => {
    const fixture = await prepareProductionFixture();
    directory = fixture.root;
    if (input?.reportBlocked === true) {
      await enableBlockedReportTool(fixture);
    }
    production = createProductionComposition({
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: async () => undefined },
      t3: new SyntheticT3(),
    });
    service = await startHeddleServer(
      { host: "127.0.0.1", port: 0 },
      { production },
    );
    const runtime = production.persistence.listReconcilerRuntime()[0]!;
    const instance = production.persistence.getInstance(runtime.instanceId)!;
    const correlationToken =
      instance.state.correlationTokens[runtime.sessionKey!];
    if (correlationToken === undefined) {
      throw new Error("fixture session has no correlation token");
    }
    const origin = `http://127.0.0.1:${service.port}`;
    const client = new Client({
      name: "console-disclosure-fixture",
      version: "1.0.0",
    });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        authProvider: { token: async () => correlationToken },
      }),
    );
    return { client, correlationToken, fixture, origin, runtime };
  };

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

  it("redacts the deployed event feed while preserving the exact durable activation bytes", async () => {
    directory = await mkdtemp(join(tmpdir(), "heddle-deployment-server-"));
    const correlationToken = "deployment-fixture-credential";
    const futurePrivateValue = "deployment-future-private-fixture";
    const systemPrompt = "# Generic deployment fixture instructions";
    const renderedDocument = `${systemPrompt}\n\n---
format: "heddle.stage-handoff"
version: 1
instanceId: "task-101"
sessionKey: "session-101"
taskId: 101
stage: "inspect"
correlationToken: "${correlationToken}"
---
# Inspect the generated sample`;
    const writer = new SqlitePersistence({ stateDirectory: directory });
    writer.createInstance("task-101", {
      correlationTokens: { "session-101": correlationToken },
      flowcraftContext: { awaitingNodeIds: ["inspect"] },
      handoffs: [],
      todoState: null,
    });
    writer.appendEvent("task-101", "session:activated", {
      format: "heddle.session-activation",
      futurePrivateField: futurePrivateValue,
      instanceId: "task-101",
      renderedDocument,
      sessionKey: "session-101",
      stage: "inspect",
      systemPrompt,
      taskId: 101,
      threadId: "thread-101",
      version: 1,
    });
    writer.close();
    const activationPayloadBytes = (): string => {
      const database = new Database(join(directory, "heddle-state.sqlite"), {
        readonly: true,
      });
      const row = database
        .prepare(
          `SELECT payload_json
           FROM heddle_instance_events
           WHERE instance_id = ? AND type = ?`,
        )
        .get("task-101", "session:activated") as
        { payload_json: string } | undefined;
      database.close();
      if (row === undefined) throw new Error("fixture activation is absent");
      return row.payload_json;
    };
    const before = activationPayloadBytes();

    service = await startHeddleServer(
      {
        boardDirectory: join(directory, "unused-board"),
        host: "127.0.0.1",
        port: 0,
        stateDirectory: directory,
      },
      { board },
    );
    const response = await globalThis.fetch(
      `http://127.0.0.1:${service.port}/api/events?instance=task-101&after=0`,
    );
    const serialized = await response.text();

    expect(response.status).toBe(200);
    expect(serialized).not.toContain(correlationToken);
    expect(serialized).not.toContain(futurePrivateValue);
    expect(serialized).not.toContain("correlationToken:");
    expect(serialized).toContain("# Inspect the generated sample");

    expect(activationPayloadBytes()).toBe(before);
  });

  it("gates a correlation token written by the real MCP blocked-report tool", async () => {
    const subject = await startDisclosureFixture({ reportBlocked: true });
    await expect(
      subject.client.callTool({
        arguments: {
          message: `A generated dependency contains ${subject.correlationToken}`,
        },
        name: "report_blocked",
      }),
    ).resolves.toMatchObject({ structuredContent: { recorded: true } });

    const response = await globalThis.fetch(`${subject.origin}/api/events`);
    const serialized = await response.text();
    const durable = production!.persistence
      .replayEvents(subject.runtime.instanceId)
      .find(({ type }) => type === "mcp:blocked-reported");

    expect(response.status).toBe(503);
    expect(serialized).not.toContain(subject.correlationToken);
    expect(JSON.stringify(durable)).toContain(subject.correlationToken);
  });

  it("gates a correlation token written by the production attention queue", async () => {
    const subject = await startDisclosureFixture();
    await production!.attention.raise({
      attentionId: "fixture-user-input-attention",
      instanceId: subject.runtime.instanceId,
      kind: "user-input",
      message: `Generated input contains ${subject.correlationToken}`,
      questions: [
        {
          id: "fixture-question",
          multiSelect: false,
          options: [{ label: "Continue" }, { label: "Wait" }],
          question: `Choose without exposing ${subject.correlationToken}`,
        },
      ],
      requestId: "fixture-request",
      sessionKey: subject.runtime.sessionKey!,
      threadId: subject.runtime.threadId!,
    });

    const response = await globalThis.fetch(`${subject.origin}/api/attention`);
    const serialized = await response.text();
    const durable = production!.persistence.listAttention();

    expect(response.status).toBe(503);
    expect(serialized).not.toContain(subject.correlationToken);
    expect(JSON.stringify(durable)).toContain(subject.correlationToken);
  });

  it("gates a correlation token written by the real MCP advance output", async () => {
    const subject = await startDisclosureFixture();
    await expect(
      subject.client.callTool({
        arguments: {
          disposition: "complete",
          output: { evidence: subject.correlationToken },
        },
        name: "advance",
      }),
    ).resolves.toMatchObject({
      structuredContent: { instanceId: subject.runtime.instanceId },
    });

    const response = await globalThis.fetch(
      `${subject.origin}/api/lifecycle?task=${subject.fixture.taskId}&after=0`,
    );
    const serialized = await response.text();
    const instance = production!.persistence.getInstance(
      subject.runtime.instanceId,
    )!;
    const context = readLifecycleContext(instance);
    const durable = await Promise.all(
      context.executionIds.map((executionId) =>
        production!.persistence.flowcraftHistory.replay(executionId),
      ),
    );

    expect(response.status).toBe(503);
    expect(serialized).not.toContain(subject.correlationToken);
    expect(JSON.stringify(durable)).toContain(subject.correlationToken);
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
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
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
    expect(unavailableLifecycle.status).toBe(404);
    await expect(unavailableLifecycle.json()).resolves.toMatchObject({
      code: "lifecycle-not-started",
    });
    expect(() =>
      createProductionComposition({
        blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
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
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
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
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
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
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: async () => undefined },
      t3: new SyntheticT3(),
    });

    const result = await startHeddleServer(
      { host: "127.0.0.1", port: 0 },
      { production, productionFactory: () => production! },
    ).catch((error: unknown) => error);
    if (typeof result === "object" && result !== null && "close" in result) {
      await (result as HeddleDeploymentServer).close();
    }
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toContain(
      "A production composition and production factory cannot both be supplied",
    );
  });
});
