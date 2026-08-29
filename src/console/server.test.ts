import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BoardTask } from "../board-adapter/index.js";
import { createConsoleServer } from "./server.js";
import type {
  ConsoleAttention,
  ConsoleBoard,
  ConsoleEvent,
  ConsoleInstance,
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
    {
      attentionId: "attention-1",
      kind: "stale-instance",
      message: "A record has waited for inspection",
      taskId: 52,
    },
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
    const [page, styles, client, boardResponse, instances, events, attention] =
      await Promise.all([
        globalThis.fetch(`${baseUrl}/?scope=epic:51`),
        globalThis.fetch(`${baseUrl}/assets/console.css`),
        globalThis.fetch(`${baseUrl}/assets/console.js`),
        globalThis.fetch(`${baseUrl}/api/board`),
        globalThis.fetch(`${baseUrl}/api/instances`),
        globalThis.fetch(`${baseUrl}/api/events?instance=instance-52&after=6`),
        globalThis.fetch(`${baseUrl}/api/attention`),
      ]);

    await expect(page.text()).resolves.toContain("KANBAN PROJECTION");
    expect(page.headers.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
    await expect(styles.text()).resolves.toContain(".task-card");
    await expect(client.text()).resolves.toContain(
      'url.searchParams.set("scope", scopeElement.value)',
    );
    const clientSource = await (
      await globalThis.fetch(`${baseUrl}/assets/console.js`)
    ).text();
    expect(clientSource).toContain("card.draggable = false");
    expect(clientSource).toContain('stage.className = "stage-readout"');
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

  it("rejects malformed scope and lever inputs before a board write", async () => {
    const invalidScope = await globalThis.fetch(
      `${baseUrl}/api/projection?scope=epic:0`,
    );
    const unsafeSequence = await globalThis.fetch(
      `${baseUrl}/api/events?after=99999999999999999`,
    );
    const unsafeEpic = await globalThis.fetch(
      `${baseUrl}/api/epics/99999999999999999/in-progress`,
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
    expect(unsafeEpic.status).toBe(400);
    expect(wrongMethod.status).toBe(405);
    expect(missingContentType.status).toBe(400);
    expect(oversizedBody.status).toBe(400);
    expect(invalidLever.status).toBe(400);
    expect(board.writes).toEqual([]);
  });
});
