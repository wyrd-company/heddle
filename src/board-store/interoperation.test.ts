// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KanbanBoardStore } from "./index.js";

const execute = promisify(execFile);

const BOARD_CONFIG = `version: 11
board:
    name: Sample Collection
tasks_dir: tasks
statuses:
    - name: backlog
      show_duration: false
    - name: todo
    - name: in-progress
    - name: done
      show_duration: false
    - name: archived
      show_duration: false
priorities:
    - low
    - medium
    - high
defaults:
    status: backlog
    priority: medium
    class: standard
claim_timeout: 1h
classes:
    - name: standard
tui:
    title_lines: 2
    age_thresholds: []
next_id: 1
`;

describe("kanban-md interoperation", () => {
  let boardDirectory: string;
  let store: KanbanBoardStore;

  const kanban = async (...arguments_: string[]): Promise<string> =>
    (await execute("kanban-md", ["--dir", boardDirectory, ...arguments_]))
      .stdout;

  beforeEach(async () => {
    boardDirectory = await mkdtemp(join(tmpdir(), "board-interop-test-"));
    await mkdir(join(boardDirectory, "tasks"));
    await writeFile(join(boardDirectory, "config.yml"), BOARD_CONFIG);
    store = new KanbanBoardStore(boardDirectory);
  });

  afterEach(async () => {
    await rm(boardDirectory, { force: true, recursive: true });
  });

  it("writes a task the CLI reads, whose unowned properties survive a CLI edit", async () => {
    const created = await store.createTask({
      body: "Record the selected storage locations.",
      priority: "high",
      properties: { repos: ["sample-alpha", "sample-beta"] },
      status: "todo",
      tags: ["lifecycle:sample"],
      title: "Record storage locations",
    });

    const seenByCli = JSON.parse(
      await kanban("show", String(created.id), "--json"),
    ) as Record<string, unknown>;
    expect(seenByCli).toMatchObject({
      id: created.id,
      priority: "high",
      status: "todo",
      tags: ["lifecycle:sample"],
      title: "Record storage locations",
    });

    await kanban("edit", String(created.id), "--status", "in-progress");

    await expect(store.readTask(created.id)).resolves.toMatchObject({
      status: "in-progress",
    });
    const frontMatter = (
      await store.readTask(created.id)
    ).document.frontMatter.toJSON() as Record<string, unknown>;
    expect(frontMatter["repos"]).toEqual(["sample-alpha", "sample-beta"]);
  });

  it("reads a task the CLI created, including an unowned property added to it", async () => {
    const created = JSON.parse(
      await kanban(
        "create",
        "Count storage crates",
        "--status",
        "todo",
        "--tags",
        "lifecycle:sample",
        "--json",
      ),
    ) as { file: string; id: number };
    const source = await readFile(created.file, "utf8");
    await writeFile(
      created.file,
      source.replace(
        "class: standard\n",
        "class: standard\nrepos:\n    - sample-alpha\n",
      ),
    );

    const task = await store.readTask(created.id);

    expect(task).toMatchObject({
      id: created.id,
      status: "todo",
      tags: ["lifecycle:sample"],
      title: "Count storage crates",
    });
    expect(
      (task.document.frontMatter.toJSON() as Record<string, unknown>)["repos"],
    ).toEqual(["sample-alpha"]);
  });

  it("keeps an unowned property through a write of Heddle's own", async () => {
    const created = await store.createTask({
      properties: { repos: ["sample-alpha"] },
      status: "todo",
      title: "Record storage locations",
    });

    await store.editTaskStatus(created.id, "in-progress");
    await store.appendTaskBody(created.id, "Appended line.");

    const frontMatter = (
      await store.readTask(created.id)
    ).document.frontMatter.toJSON() as Record<string, unknown>;
    expect(frontMatter["repos"]).toEqual(["sample-alpha"]);
    expect(
      JSON.parse(await kanban("show", String(created.id), "--json")),
    ).toMatchObject({ status: "in-progress" });
  });

  it("keeps a Heddle status edit readable by the CLI", async () => {
    const created = await store.createTask({
      status: "todo",
      title: "Prepare display shelves",
    });

    await store.editTaskStatus(created.id, "in-progress");

    expect(
      JSON.parse(await kanban("show", String(created.id), "--json")),
    ).toMatchObject({ status: "in-progress" });
  });
});
