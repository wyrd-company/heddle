import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BoardTask } from "../board-adapter/index.js";
import { createConsoleAttention } from "./attention-contract.js";
import { createConsoleServer } from "./server.js";
import { ConsoleLifecycleUnavailableError } from "./types.js";
import type {
  ConsoleAttention,
  ConsoleBoard,
  ConsoleEvent,
  ConsoleInstance,
  ConsoleLifecycleSnapshot,
  ConsoleStateSource,
} from "./types.js";

const task = (
  id: number,
  title: string,
  status: string,
  overrides: Partial<BoardTask> = {},
): BoardTask => ({
  blocked: false,
  dependencies: [],
  id,
  priority: "medium",
  status,
  tags: [],
  title,
  ...overrides,
});

class FixtureBoard implements ConsoleBoard {
  readonly writes: Array<{ inProgress: boolean; taskId: number }> = [];
  readonly tasks = [
    task(51, "Seasonal display", "in-progress", { tags: ["type:epic"] }),
    task(52, "Count storage crates", "in-progress", { parent: 51 }),
    task(53, "Prepare shelf labels", "todo", { parent: 51 }),
    task(80, "Repair reading-room lamp", "done"),
  ];

  async readBoard(): Promise<BoardTask[]> {
    return this.tasks.map((item) => ({ ...item, tags: [...item.tags] }));
  }

  async readBoardStatuses(): Promise<string[]> {
    return ["todo", "in-progress", "done"];
  }

  async setEpicInProgress(taskId: number, inProgress: boolean): Promise<void> {
    this.writes.push({ inProgress, taskId });
    const item = this.tasks.find(({ id }) => id === taskId);
    if (item === undefined) throw new Error("fixture task is absent");
    item.status = inProgress ? "in-progress" : "todo";
  }
}

class FixtureState implements ConsoleStateSource {
  readonly attention: ConsoleAttention[] = [
    createConsoleAttention({
      actions: [],
      attentionId: "attention-1",
      kind: "stale-instance",
      message: "A record has waited for inspection",
      scope: "task:52",
      taskId: 52,
    }),
  ];
  readonly events: ConsoleEvent[] = [
    {
      instanceId: "instance-52",
      payload: { disposition: "ready" },
      recordedAt: "2026-01-01T00:02:00.000Z",
      sequence: 7,
      type: "sample:recorded",
    },
  ];
  readonly instances: ConsoleInstance[] = [
    {
      instanceId: "instance-52",
      stageEnteredAt: 60_000,
      stageId: "inspect",
      taskId: 52,
    },
  ];

  async listAttention(): Promise<ConsoleAttention[]> {
    return this.attention;
  }

  async listEvents(input: {
    afterSequence: number;
    instanceId?: string;
  }): Promise<ConsoleEvent[]> {
    return this.events.filter(
      ({ instanceId, sequence }) =>
        sequence > input.afterSequence &&
        (input.instanceId === undefined || input.instanceId === instanceId),
    );
  }

  async listInstances(): Promise<ConsoleInstance[]> {
    return this.instances;
  }

  async readLifecycle(input: {
    afterSequence: number;
    taskId: number;
  }): Promise<ConsoleLifecycleSnapshot> {
    const events = [
      {
        executionId: "execution-52",
        payload: { nodeId: "inspect" },
        sequence: 1,
        type: "node:start",
      },
    ];
    return {
      blueprint: {
        blobHash: "a".repeat(40),
        edges: [],
        id: "sample-lifecycle",
        nodes: [{ id: "inspect", uses: "wait" }],
        path: "blueprints/sample-lifecycle.json",
      },
      currentStageIds: ["inspect"],
      events: events.filter(({ sequence }) => sequence > input.afterSequence),
      instanceId: "instance-52",
      nextSequence: 1,
      status: "awaiting",
      taskId: input.taskId,
    };
  }
}

describe("console server", () => {
  let baseUrl: string;
  let board: FixtureBoard;
  let server: ReturnType<typeof createConsoleServer>;

  beforeEach(async () => {
    board = new FixtureBoard();
    server = createConsoleServer({
      board,
      now: () => 180_000,
      state: new FixtureState(),
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    );
  });

  it("serves the shell and read-only board, instance, event, and attention APIs", async () => {
    const [
      page,
      styles,
      client,
      lifecycleStyles,
      lifecycleClient,
      boardResponse,
      instances,
      events,
      attention,
    ] = await Promise.all([
      globalThis.fetch(`${baseUrl}/?scope=epic:51`),
      globalThis.fetch(`${baseUrl}/assets/console.css`),
      globalThis.fetch(`${baseUrl}/assets/console.js`),
      globalThis.fetch(`${baseUrl}/assets/lifecycle.css`),
      globalThis.fetch(`${baseUrl}/assets/lifecycle.js`),
      globalThis.fetch(`${baseUrl}/api/board`),
      globalThis.fetch(`${baseUrl}/api/instances`),
      globalThis.fetch(`${baseUrl}/api/events?instance=instance-52&after=6`),
      globalThis.fetch(`${baseUrl}/api/attention`),
    ]);

    await expect(page.text()).resolves.toContain("KANBAN PROJECTION");
    expect(page.headers.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
    expect(page.headers.get("content-security-policy")).toContain(
      "style-src-attr 'unsafe-inline'",
    );
    await expect(lifecycleStyles.text()).resolves.toContain(
      ".lifecycle-renderer",
    );
    await expect(lifecycleClient.text()).resolves.toContain(
      "heddleLifecycleViewer",
    );
    await expect(styles.text()).resolves.toContain(".task-card");
    await expect(client.text()).resolves.toContain(
      'url.searchParams.set("scope", scopeElement.value)',
    );
    const clientSource = await (
      await globalThis.fetch(`${baseUrl}/assets/console.js`)
    ).text();
    expect(clientSource).toContain("card.draggable = false");
    expect(clientSource).not.toContain("contentEditable = true");
    expect(clientSource).toContain("if (task.stageId) {");
    expect(clientSource).toContain("const requestedScope = scopeFromUrl();");
    expect(clientSource).toContain("if (isEpic(task)) {");
    expect(clientSource).toContain('stage.className = "stage-readout"');
    expect(clientSource).toContain(
      'await fetchJson("/api/epics/" + task.id + "/in-progress", {',
    );
    expect(clientSource).toContain(
      "body: JSON.stringify({ inProgress: target })",
    );
    expect(clientSource).toContain('method: "PUT"');
    await expect(boardResponse.json()).resolves.toMatchObject({
      statuses: ["todo", "in-progress", "done"],
      tasks: expect.arrayContaining([expect.objectContaining({ id: 52 })]),
    });
    await expect(instances.json()).resolves.toEqual([
      expect.objectContaining({ stageId: "inspect", taskId: 52 }),
    ]);
    await expect(events.json()).resolves.toEqual([
      expect.objectContaining({ sequence: 7 }),
    ]);
    await expect(attention.json()).resolves.toEqual([
      expect.objectContaining({ attentionId: "attention-1" }),
    ]);
    expect(board.writes).toEqual([]);
  });

  it("serves ordered lifecycle replay and tail reads without a write", async () => {
    const [replay, tail, wrongMethod, malformedTask, malformedCursor] =
      await Promise.all([
        globalThis.fetch(`${baseUrl}/api/lifecycle?task=52&after=0`),
        globalThis.fetch(`${baseUrl}/api/lifecycle?task=52&after=1`),
        globalThis.fetch(`${baseUrl}/api/lifecycle?task=52`, {
          method: "POST",
        }),
        globalThis.fetch(`${baseUrl}/api/lifecycle?task=0`),
        globalThis.fetch(`${baseUrl}/api/lifecycle?task=52&after=-1`),
      ]);

    await expect(replay.json()).resolves.toMatchObject({
      blueprint: { blobHash: "a".repeat(40), id: "sample-lifecycle" },
      currentStageIds: ["inspect"],
      events: [{ sequence: 1, type: "node:start" }],
      nextSequence: 1,
      taskId: 52,
    });
    await expect(tail.json()).resolves.toMatchObject({ events: [] });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");
    expect(malformedTask.status).toBe(400);
    expect(malformedCursor.status).toBe(400);
    expect(board.writes).toEqual([]);
  });

  it("fails closed when the deployed lifecycle reader is unavailable", async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    );
    class UnavailableState extends FixtureState {
      override async readLifecycle(): Promise<ConsoleLifecycleSnapshot> {
        throw new ConsoleLifecycleUnavailableError(
          "Lifecycle history composition is unavailable",
        );
      }
    }
    server = createConsoleServer({ board, state: new UnavailableState() });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    const response = await globalThis.fetch(
      `${baseUrl}/api/lifecycle?task=52&after=0`,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Lifecycle history composition is unavailable",
    });
    expect(board.writes).toEqual([]);
  });

  it("opens an epic-scoped projection with stage and dwell enrichment", async () => {
    const response = await globalThis.fetch(
      `${baseUrl}/api/projection?scope=epic:51`,
    );
    const projection = (await response.json()) as {
      columns: Array<{ tasks: Array<Record<string, unknown>> }>;
      scope: unknown;
    };

    expect(projection.scope).toEqual({ epicId: 51, kind: "epic" });
    expect(projection.columns.flatMap(({ tasks }) => tasks)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dwellMilliseconds: 120_000,
          stageId: "inspect",
          title: "Count storage crates",
        }),
      ]),
    );
    expect(
      projection.columns
        .flatMap(({ tasks }) => tasks)
        .some(({ id }) => id === 80),
    ).toBe(false);
  });

  it("uses the epic lever as the only write endpoint", async () => {
    const response = await globalThis.fetch(
      `${baseUrl}/api/epics/51/in-progress`,
      {
        body: JSON.stringify({ inProgress: false }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      },
    );

    expect(response.status).toBe(204);
    expect(board.writes).toEqual([{ inProgress: false, taskId: 51 }]);
    await expect(
      globalThis.fetch(`${baseUrl}/api/board`, { method: "POST" }),
    ).resolves.toMatchObject({ status: 405 });
    expect(board.writes).toHaveLength(1);
  });

  it("accepts application/json with media-type parameters", async () => {
    const response = await globalThis.fetch(
      `${baseUrl}/api/epics/51/in-progress`,
      {
        body: JSON.stringify({ inProgress: false }),
        headers: { "content-type": "application/json; charset=utf-8" },
        method: "PUT",
      },
    );

    expect(response.status).toBe(204);
    expect(board.writes).toEqual([{ inProgress: false, taskId: 51 }]);
  });

  it("rejects semantic URL scopes before rendering a projection", async () => {
    const [childAsEpicScope, missingEpicScope, missingTaskScope] =
      await Promise.all([
        globalThis.fetch(`${baseUrl}/api/projection?scope=epic:52`),
        globalThis.fetch(`${baseUrl}/api/projection?scope=epic:999`),
        globalThis.fetch(`${baseUrl}/api/projection?scope=task:999`),
      ]);

    expect(childAsEpicScope.status).toBe(400);
    expect(missingEpicScope.status).toBe(400);
    expect(missingTaskScope.status).toBe(400);
    expect(board.writes).toEqual([]);
  });

  it("rejects lookalike JSON media types before a board write", async () => {
    const response = await globalThis.fetch(
      `${baseUrl}/api/epics/51/in-progress`,
      {
        body: JSON.stringify({ inProgress: false }),
        headers: { "content-type": "application/jsonp" },
        method: "PUT",
      },
    );

    expect(response.status).toBe(400);
    expect(board.writes).toEqual([]);
  });

  it("rejects malformed scope and lever inputs before a board write", async () => {
    const invalidScope = await globalThis.fetch(
      `${baseUrl}/api/projection?scope=epic:0`,
    );
    const unsafeSequence = await globalThis.fetch(
      `${baseUrl}/api/events?after=99999999999999999`,
    );
    const malformedSequence = await globalThis.fetch(
      `${baseUrl}/api/events?after=several`,
    );
    const nonCanonicalSequence = await globalThis.fetch(
      `${baseUrl}/api/events?after=1e2`,
    );
    const unsafeEpic = await globalThis.fetch(
      `${baseUrl}/api/epics/99999999999999999/in-progress`,
      {
        body: JSON.stringify({ inProgress: false }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      },
    );
    const malformedEpic = await globalThis.fetch(
      `${baseUrl}/api/epics/several/in-progress`,
      {
        body: JSON.stringify({ inProgress: false }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      },
    );
    const nonCanonicalEpic = await globalThis.fetch(
      `${baseUrl}/api/epics/1e2/in-progress`,
      {
        body: JSON.stringify({ inProgress: false }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      },
    );
    const wrongMethod = await globalThis.fetch(
      `${baseUrl}/api/epics/51/in-progress`,
      {
        body: JSON.stringify({ inProgress: false }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    const missingContentType = await globalThis.fetch(
      `${baseUrl}/api/epics/51/in-progress`,
      { body: JSON.stringify({ inProgress: false }), method: "PUT" },
    );
    const malformedJson = await globalThis.fetch(
      `${baseUrl}/api/epics/51/in-progress`,
      {
        body: "{",
        headers: { "content-type": "application/json" },
        method: "PUT",
      },
    );
    const oversizedBody = await globalThis.fetch(
      `${baseUrl}/api/epics/51/in-progress`,
      {
        body: JSON.stringify({ inProgress: false }) + " ".repeat(1024),
        headers: { "content-type": "application/json" },
        method: "PUT",
      },
    );
    const invalidLever = await globalThis.fetch(
      `${baseUrl}/api/epics/51/in-progress`,
      {
        body: JSON.stringify({ inProgress: false, status: "done" }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      },
    );

    expect(invalidScope.status).toBe(400);
    expect(unsafeSequence.status).toBe(400);
    expect(malformedSequence.status).toBe(400);
    expect(nonCanonicalSequence.status).toBe(400);
    expect(unsafeEpic.status).toBe(400);
    expect(malformedEpic.status).toBe(400);
    expect(nonCanonicalEpic.status).toBe(400);
    expect(wrongMethod.status).toBe(405);
    expect(missingContentType.status).toBe(400);
    expect(malformedJson.status).toBe(400);
    expect(oversizedBody.status).toBe(400);
    expect(invalidLever.status).toBe(400);
    expect(board.writes).toEqual([]);
  });
});
