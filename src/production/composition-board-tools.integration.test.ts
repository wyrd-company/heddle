// ---
// relationships:
//   verifies: heddle
// ---

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkflowMcpSessionResolver } from "../mcp-server/index.js";
import { createProductionComposition } from "./composition.js";
import {
  execute,
  prepareProductionEpicFixture,
  prepareProductionFixture,
  SyntheticT3,
} from "./composition.test-support.js";

type ToolResult = {
  id: number;
  kind: "finding" | "follow-up";
  parent: number;
  replayed: boolean;
  status: string;
};

const productionReplayUnderParallelLoadTimeoutMilliseconds = 10_000;

const callTool = async (
  composition: ReturnType<typeof createProductionComposition>,
  token: string,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<ToolResult> => {
  const response = await composition.mcp.fetch(
    new globalThis.Request("http://production.invalid/mcp", {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: arguments_, name },
      }),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    error?: unknown;
    result?: { structuredContent?: ToolResult };
  };
  if (
    body.error !== undefined ||
    body.result?.structuredContent === undefined
  ) {
    throw new Error(`MCP tool call failed: ${JSON.stringify(body)}`);
  }
  return body.result.structuredContent;
};

describe("production MCP board tools", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
  });

  it(
    "creates findings and follow-ups through the board authority without duplicating restart replays",
    async () => {
      const fixture = await prepareProductionEpicFixture();
      cleanup = fixture.cleanup;
      const options = {
        workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
        blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
        configuration: fixture.configuration,
        providerUsage: {
          readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
        },
        pushoverTransport: { send: vi.fn(async () => undefined) },
        t3: new SyntheticT3(),
      };
      let composition = createProductionComposition(options);
      await composition.start();
      const binding = await new WorkflowMcpSessionResolver(
        composition.persistence,
      ).resolve(
        Object.values(
          composition.persistence.getInstance(`task-${fixture.taskId}`)!.state
            .correlationTokens,
        )[0]!,
      );
      const followUpInput = {
        body: "Check the sample with a separate fixture.",
        lifecycle: "sample",
        operationId: "follow-up-one",
        title: "Check another sample",
      };
      const followUp = await callTool(
        composition,
        binding.token,
        "create_follow_up",
        followUpInput,
      );
      const findingInput = {
        body: "The sample fixture does not cover the alternate arrangement.",
        dependsOn: [followUp.id],
        lifecycle: "sample",
        operationId: "finding-one",
        priority: "high",
        title: "Cover the alternate arrangement",
      };
      const finding = await callTool(
        composition,
        binding.token,
        "create_finding",
        findingInput,
      );

      expect(followUp).toMatchObject({
        kind: "follow-up",
        parent: fixture.epicId,
        replayed: false,
        status: "backlog",
      });
      expect(finding).toMatchObject({
        kind: "finding",
        parent: fixture.epicId,
        replayed: false,
        status: "backlog",
      });
      let board = await composition.board.readBoard();
      expect(board.find(({ id }) => id === followUp.id)).toMatchObject({
        parent: fixture.epicId,
        status: "backlog",
        tags: expect.arrayContaining(["type:follow-up", "lifecycle:sample"]),
      });
      expect(board.find(({ id }) => id === finding.id)).toMatchObject({
        dependencies: [followUp.id],
        parent: fixture.epicId,
        priority: "high",
        status: "backlog",
        tags: expect.arrayContaining(["type:finding", "lifecycle:sample"]),
      });

      await composition.close();
      composition = createProductionComposition({
        workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
        ...options,
        t3: new SyntheticT3(),
      });
      await composition.start();
      await expect(
        callTool(composition, binding.token, "create_follow_up", followUpInput),
      ).resolves.toMatchObject({ id: followUp.id, replayed: true });
      await expect(
        callTool(composition, binding.token, "create_finding", findingInput),
      ).resolves.toMatchObject({ id: finding.id, replayed: true });
      board = await composition.board.readBoard();
      expect(
        board.filter(({ tags }) =>
          tags.some((tag) => tag.startsWith("heddle-operation:")),
        ),
      ).toHaveLength(2);
      await composition.close();
    },
    productionReplayUnderParallelLoadTimeoutMilliseconds,
  );

  it("keeps a pre-board crash pending and creates exactly once when the MCP operation replays", async () => {
    const fixture = await prepareProductionEpicFixture();
    cleanup = fixture.cleanup;
    let failAfterIntent = true;
    const options = {
      afterDynamicTaskIntentRecorded: () => {
        if (!failAfterIntent) return;
        failAfterIntent = false;
        throw new Error("Injected crash after dynamic task intent");
      },
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
    };
    let composition = createProductionComposition(options);
    await composition.start();
    const binding = await new WorkflowMcpSessionResolver(
      composition.persistence,
    ).resolve(
      Object.values(
        composition.persistence.getInstance(`task-${fixture.taskId}`)!.state
          .correlationTokens,
      )[0]!,
    );
    const input = {
      body: "Inspect the independent sample after a restart.",
      lifecycle: "sample",
      operationId: "pre-board-crash",
      title: "Inspect another sample",
    };

    await expect(
      callTool(composition, binding.token, "create_follow_up", input),
    ).rejects.toThrow("MCP tool call failed");
    expect(
      composition.persistence.listDynamicTaskIntents("pending"),
    ).toHaveLength(1);
    expect(
      (await composition.board.readBoard()).filter(({ tags }) =>
        tags.some((tag) => tag.startsWith("heddle-operation:")),
      ),
    ).toHaveLength(0);
    await composition.close();

    composition = createProductionComposition({
      ...options,
      afterDynamicTaskIntentRecorded: undefined,
      t3: new SyntheticT3(),
    });
    await composition.start();
    expect(
      composition.persistence.listDynamicTaskIntents("pending"),
    ).toHaveLength(1);
    expect(
      composition.attention
        .list()
        .filter(({ kind }) => kind === "production-error"),
    ).toHaveLength(0);
    await composition.close();
    composition = createProductionComposition({
      ...options,
      afterDynamicTaskIntentRecorded: undefined,
      t3: new SyntheticT3(),
    });
    await composition.start();
    expect(
      composition.persistence.listDynamicTaskIntents("pending"),
    ).toHaveLength(1);
    expect(
      (await composition.board.readBoard()).filter(({ tags }) =>
        tags.some((tag) => tag.startsWith("heddle-operation:")),
      ),
    ).toHaveLength(0);
    const created = await callTool(
      composition,
      binding.token,
      "create_follow_up",
      input,
    );
    expect(created.replayed).toBe(true);
    expect(
      composition.persistence.listDynamicTaskIntents("completed"),
    ).toMatchObject([{ taskId: created.id }]);
    expect(
      (await composition.board.readBoard()).filter(({ tags }) =>
        tags.some((tag) => tag.startsWith("heddle-operation:")),
      ),
    ).toHaveLength(1);
    await composition.close();
  });

  it("binds one exact board task after a post-board crash before reconciliation starts", async () => {
    const fixture = await prepareProductionEpicFixture();
    cleanup = fixture.cleanup;
    let failAfterBoard = true;
    const options = {
      afterDynamicTaskBoardEffect: () => {
        if (!failAfterBoard) return;
        failAfterBoard = false;
        throw new Error("Injected crash after dynamic board effect");
      },
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
    };
    let composition = createProductionComposition(options);
    await composition.start();
    const binding = await new WorkflowMcpSessionResolver(
      composition.persistence,
    ).resolve(
      Object.values(
        composition.persistence.getInstance(`task-${fixture.taskId}`)!.state
          .correlationTokens,
      )[0]!,
    );
    const input = {
      body: "Recheck the independent sample after recovery.",
      lifecycle: "sample",
      operationId: "post-board-crash",
      title: "Recheck another sample",
    };

    await expect(
      callTool(composition, binding.token, "create_finding", input),
    ).rejects.toThrow("MCP tool call failed");
    const pending = composition.persistence.listDynamicTaskIntents("pending");
    expect(pending).toHaveLength(1);
    const boardTask = (await composition.board.readBoard()).find(({ tags }) =>
      tags.includes(`heddle-operation:${pending[0]!.operationDigest}`),
    );
    expect(boardTask).toBeDefined();
    await composition.close();

    composition = createProductionComposition({
      ...options,
      afterDynamicTaskBoardEffect: undefined,
      t3: new SyntheticT3(),
    });
    const registryStateAtBoardRead: string[] = [];
    const readBoard = composition.board.readBoard.bind(composition.board);
    vi.spyOn(composition.board, "readBoard").mockImplementation(async () => {
      registryStateAtBoardRead.push(
        composition.persistence.listDynamicTaskIntents()[0]!.state,
      );
      return readBoard();
    });
    await composition.start();
    expect(registryStateAtBoardRead.slice(0, 2)).toEqual([
      "pending",
      "completed",
    ]);
    expect(
      composition.persistence.listDynamicTaskIntents("pending"),
    ).toHaveLength(0);
    expect(composition.dynamicTasks.verifyTask(boardTask!)).toMatchObject({
      state: "completed",
      taskId: boardTask!.id,
    });
    await composition.close();
    composition = createProductionComposition({
      ...options,
      afterDynamicTaskBoardEffect: undefined,
      t3: new SyntheticT3(),
    });
    await composition.start();
    expect(
      composition.persistence.listDynamicTaskIntents("completed"),
    ).toHaveLength(1);
    await expect(
      callTool(composition, binding.token, "create_finding", input),
    ).resolves.toMatchObject({ id: boardTask!.id, replayed: true });
    expect(
      (await composition.board.readBoard()).filter(({ tags }) =>
        tags.some((tag) => tag.startsWith("heddle-operation:")),
      ),
    ).toHaveLength(1);
    await composition.close();
  });

  it("fails startup before effects when a wait node names an unregistered tool", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const path = join(
      fixture.blueprintsRepositoryRoot,
      "blueprints/sample.json",
    );
    const artifact = JSON.parse(await readFile(path, "utf8")) as {
      nodes: Array<{ id: string; tools?: string[] }>;
    };
    artifact.nodes
      .find(({ id }) => id === "implement")!
      .tools!.push("missing_tool");
    await writeFile(path, `${JSON.stringify(artifact)}\n`);
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
        "Add invalid tool declaration",
      ],
      { cwd: fixture.blueprintsRepositoryRoot },
    );
    await execute("git", ["push", "--quiet", "origin", "main"], {
      cwd: fixture.blueprintsRepositoryRoot,
    });
    const t3 = new SyntheticT3();
    const composition = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    });

    await expect(composition.start()).rejects.toThrow(
      "Blueprint 'sample' node 'implement' declares MCP tool 'missing_tool' that is not registered",
    );
    expect(
      t3.commands.filter(({ type }) => type !== "project.create"),
    ).toHaveLength(0);
    await composition.close();
  });
});
