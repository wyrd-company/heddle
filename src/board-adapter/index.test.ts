// ---
// relationships:
//   implements: heddle
// ---

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KanbanBoardAdapter, type KanbanCommandRunner } from "./index.js";

const execute = promisify(execFile);

describe("KanbanBoardAdapter", () => {
  let boardDirectory: string;
  let commands: string[][];
  let adapter: KanbanBoardAdapter;

  const runKanban: KanbanCommandRunner = async (arguments_) => {
    commands.push(arguments_);
    const result = await execute("kanban-md", arguments_);
    return result.stdout;
  };

  const createTask = async (...arguments_: string[]): Promise<number> => {
    const output = await runKanban([
      "--dir",
      boardDirectory,
      "create",
      ...arguments_,
      "--json",
    ]);
    return (JSON.parse(output) as { id: number }).id;
  };

  beforeEach(async () => {
    boardDirectory = await mkdtemp(join(tmpdir(), "board-adapter-test-"));
    commands = [];
    await mkdir(join(boardDirectory, "tasks"));
    await writeFile(
      join(boardDirectory, "config.yml"),
      `version: 11
board:
  name: Sample Collection
tasks_dir: tasks
statuses:
  - name: backlog
    show_duration: false
  - name: todo
  - name: in-progress
  - name: uat
  - name: done
    show_duration: false
  - name: archived
    show_duration: false
priorities:
  - low
  - medium
  - high
  - critical
defaults:
  status: backlog
  priority: medium
  class: standard
claim_timeout: 1h
classes:
  - name: expedite
    wip_limit: 1
    bypass_column_wip: true
  - name: fixed-date
  - name: standard
  - name: intangible
tui:
  title_lines: 2
  age_thresholds:
    - after: 0s
      color: "242"
next_id: 1
`,
    );
    commands = [];
    adapter = new KanbanBoardAdapter(boardDirectory, runKanban);
  });

  afterEach(async () => {
    await rm(boardDirectory, { recursive: true });
  });

  it("reads parentage, dependencies, and both lifecycle representations", async () => {
    const collectionId = await createTask(
      "Seasonal collection",
      "--status",
      "in-progress",
      "--tags",
      "sample,lifecycle:collection-renewal",
    );
    const inventoryId = await createTask(
      "Count storage crates",
      "--parent",
      String(collectionId),
    );
    await runKanban([
      "--dir",
      boardDirectory,
      "edit",
      String(inventoryId),
      "--block",
      "Awaiting a storage-room key",
      "--json",
    ]);
    const displayId = await createTask(
      "Prepare display shelves",
      "--parent",
      String(collectionId),
      "--depends-on",
      String(inventoryId),
      "--tags",
      "sample,lifecycle:ignored-fallback",
    );

    const display = JSON.parse(
      await runKanban([
        "--dir",
        boardDirectory,
        "show",
        String(displayId),
        "--json",
      ]),
    ) as { file: string };
    const source = await readFile(display.file, "utf8");
    await writeFile(
      display.file,
      source.replace(
        "class: standard\n---",
        "class: standard\nlifecycle: exhibit-preparation\n---",
      ),
    );

    const tasks = await adapter.readBoard();

    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: collectionId,
          lifecycle: "collection-renewal",
        }),
        expect.objectContaining({
          blocked: true,
          id: inventoryId,
        }),
        expect.objectContaining({
          id: displayId,
          parent: collectionId,
          dependencies: [inventoryId],
          lifecycle: "exhibit-preparation",
        }),
      ]),
    );
  });

  it("reads declared product and repository authority from front matter", async () => {
    const taskId = await createTask("Arrange sample items");
    const task = JSON.parse(
      await runKanban([
        "--dir",
        boardDirectory,
        "show",
        String(taskId),
        "--json",
      ]),
    ) as { file: string };
    const source = await readFile(task.file, "utf8");
    await writeFile(
      task.file,
      source.replace(
        "class: standard\n---",
        "class: standard\nproduct: sample-product\nrepos:\n  - sample-alpha\n  - sample-beta\n---",
      ),
    );

    await expect(adapter.readTask(taskId)).resolves.toMatchObject({
      frontMatter: {
        id: taskId,
        product: "sample-product",
        repos: ["sample-alpha", "sample-beta"],
        title: "Arrange sample items",
      },
      product: "sample-product",
      repos: ["sample-alpha", "sample-beta"],
    });
  });

  it.each([
    "repos: []",
    "repos: [sample-alpha, sample-alpha]",
    "repos: ../outside",
  ])("rejects an invalid declared repository catalog: %s", async (repos) => {
    const taskId = await createTask("Arrange sample items");
    const task = JSON.parse(
      await runKanban([
        "--dir",
        boardDirectory,
        "show",
        String(taskId),
        "--json",
      ]),
    ) as { file: string };
    const source = await readFile(task.file, "utf8");
    await writeFile(
      task.file,
      source.replace("class: standard\n---", `class: standard\n${repos}\n---`),
    );

    await expect(adapter.readTask(taskId)).rejects.toThrow(/repos declaration/);
  });

  it("reads every configured board column in board order", async () => {
    await expect(adapter.readBoardStatuses()).resolves.toEqual([
      "backlog",
      "todo",
      "in-progress",
      "uat",
      "done",
    ]);
  });

  it("mirrors child status through kanban-md", async () => {
    const collectionId = await createTask("Seasonal collection");
    const childId = await createTask(
      "Label storage crates",
      "--parent",
      String(collectionId),
    );
    commands = [];

    await adapter.mirrorChildStatus(childId, "done");

    expect(commands.at(-1)).toEqual([
      "--dir",
      boardDirectory,
      "edit",
      String(childId),
      "--status",
      "done",
      "--json",
    ]);
    await expect(adapter.readTask(childId)).resolves.toMatchObject({
      status: "done",
    });
    await expect(
      adapter.mirrorChildStatus(collectionId, "done"),
    ).rejects.toThrow("is not a child task");
  });

  it("mirrors standalone status while preserving the epic status boundary", async () => {
    const collectionId = await createTask(
      "Seasonal collection",
      "--tags",
      "type:epic",
    );
    const standaloneId = await createTask("Repair reading-room lamp");
    const childId = await createTask(
      "Label storage crates",
      "--parent",
      String(collectionId),
    );

    await adapter.mirrorTaskStatus(standaloneId, "in-progress");
    await adapter.mirrorTaskStatus(childId, "done");

    await expect(adapter.readTask(standaloneId)).resolves.toMatchObject({
      status: "in-progress",
    });
    await expect(adapter.readTask(childId)).resolves.toMatchObject({
      status: "done",
    });
    await expect(
      adapter.mirrorTaskStatus(collectionId, "done"),
    ).rejects.toThrow("is an epic task");
  });

  it("limits epic transitions to uat and done", async () => {
    const collectionId = await createTask(
      "Seasonal collection",
      "--tags",
      "type:epic",
    );
    const standaloneId = await createTask("Repair reading-room lamp");
    const childId = await createTask(
      "Label storage crates",
      "--parent",
      String(collectionId),
    );

    await adapter.transitionEpicStatus(collectionId, "uat");

    await expect(adapter.readTask(collectionId)).resolves.toMatchObject({
      status: "uat",
    });
    await expect(
      adapter.transitionEpicStatus(collectionId, "todo" as "uat"),
    ).rejects.toThrow("epic status transition is not allowed");
    await expect(adapter.transitionEpicStatus(childId, "done")).rejects.toThrow(
      "is not an epic task",
    );
    commands = [];
    await expect(
      adapter.transitionEpicStatus(standaloneId, "done"),
    ).rejects.toThrow("is not an epic task");
    expect(commands).not.toContainEqual(
      expect.arrayContaining(["edit", String(standaloneId)]),
    );
  });

  it("moves only an epic in and out of in-progress", async () => {
    const collectionId = await createTask(
      "Seasonal collection",
      "--tags",
      "type:epic",
    );
    const childId = await createTask(
      "Label storage crates",
      "--parent",
      String(collectionId),
    );
    const standaloneId = await createTask("Repair reading-room lamp");
    commands = [];

    await adapter.setEpicInProgress(collectionId, true);
    await expect(adapter.readTask(collectionId)).resolves.toMatchObject({
      status: "in-progress",
    });
    await adapter.setEpicInProgress(collectionId, false);
    await expect(adapter.readTask(collectionId)).resolves.toMatchObject({
      status: "todo",
    });

    commands = [];
    await expect(adapter.setEpicInProgress(childId, true)).rejects.toThrow(
      "is not an epic task",
    );
    await expect(adapter.setEpicInProgress(standaloneId, true)).rejects.toThrow(
      "is not an epic task",
    );
    expect(commands).not.toContainEqual(
      expect.arrayContaining(["edit", String(childId)]),
    );
    expect(commands).not.toContainEqual(
      expect.arrayContaining(["edit", String(standaloneId)]),
    );
  });

  it("creates follow-ups and findings that a later board read sees", async () => {
    const collectionId = await createTask("Seasonal collection");

    const followUp = await adapter.createRecord({
      kind: "follow-up",
      title: "Replace worn shelf labels",
      body: "Use labels that remain readable under gallery lighting.",
      parent: collectionId,
      lifecycle: "small-maintenance",
    });
    const finding = await adapter.createRecord({
      kind: "finding",
      title: "Document crate has a loose hinge",
      body: "The rear hinge moves when the lid opens.",
      parent: collectionId,
      dependsOn: [followUp.id],
      lifecycle: "inspection-response",
      priority: "high",
    });

    const tasks = await adapter.readBoard();
    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: followUp.id,
          tags: expect.arrayContaining([
            "type:follow-up",
            "lifecycle:small-maintenance",
          ]),
        }),
        expect.objectContaining({
          id: finding.id,
          dependencies: [followUp.id],
          lifecycle: "inspection-response",
          tags: expect.arrayContaining(["type:finding"]),
        }),
      ]),
    );
  });
});
