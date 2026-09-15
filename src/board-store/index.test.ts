// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KanbanBoardStore } from "./index.js";
import { writeFileAtomic } from "./atomic-write.js";

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

describe("KanbanBoardStore", () => {
  let boardDirectory: string;
  let store: KanbanBoardStore;

  const kanban = async (...arguments_: string[]): Promise<string> =>
    (await execute("kanban-md", ["--dir", boardDirectory, ...arguments_]))
      .stdout;

  const taskSource = async (taskId: number): Promise<string> =>
    readFile((await store.readTask(taskId)).file, "utf8");

  beforeEach(async () => {
    boardDirectory = await mkdtemp(join(tmpdir(), "board-store-test-"));
    await mkdir(join(boardDirectory, "tasks"));
    await writeFile(join(boardDirectory, "config.yml"), BOARD_CONFIG);
    store = new KanbanBoardStore(boardDirectory);
  });

  afterEach(async () => {
    await rm(boardDirectory, { force: true, recursive: true });
  });

  describe("interoperation with a real kanban-md", () => {
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
        (task.document.frontMatter.toJSON() as Record<string, unknown>)[
          "repos"
        ],
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

  describe("task id allocation", () => {
    it("allocates ids that do not collide when the CLI and Heddle interleave", async () => {
      const allocated: number[] = [];
      for (let round = 0; round < 3; round += 1) {
        allocated.push(
          (
            JSON.parse(
              await kanban("create", `CLI item ${round}`, "--json"),
            ) as { id: number }
          ).id,
        );
        allocated.push(
          (await store.createTask({ title: `Heddle item ${round}` })).id,
        );
      }

      expect(allocated).toEqual([1, 2, 3, 4, 5, 6]);
      expect(new Set(allocated).size).toBe(allocated.length);
      expect(await readdir(join(boardDirectory, "tasks"))).toHaveLength(6);
      // The CLI's own next allocation continues the same sequence.
      expect(
        JSON.parse(await kanban("create", "CLI item last", "--json")),
      ).toMatchObject({ id: 7 });
    });

    it("allocates above every existing file when next_id has fallen behind", async () => {
      // A board whose next_id lags the files on disk by more than any retry
      // budget: the id has to be derived from the files, not from next_id.
      for (let index = 0; index < 20; index += 1) {
        await store.createTask({ title: `Existing item ${index}` });
      }
      const config = await readFile(join(boardDirectory, "config.yml"), "utf8");
      await writeFile(
        join(boardDirectory, "config.yml"),
        config.replace("next_id: 21", "next_id: 1"),
      );

      const created = await store.createTask({ title: "Arriving item" });

      expect(created.id).toBe(21);
      await expect(
        readFile(join(boardDirectory, "config.yml"), "utf8"),
      ).resolves.toContain("next_id: 22");
      expect(await readdir(join(boardDirectory, "tasks"))).toHaveLength(21);
    });

    it("gives concurrent writers distinct ids and one file each", async () => {
      // Both writers choose an id before either has written, so the guard that
      // separates them is the check each makes after writing.
      const [first, second] = await Promise.all([
        new KanbanBoardStore(boardDirectory).createTask({
          title: "Alpha item",
        }),
        new KanbanBoardStore(boardDirectory).createTask({ title: "Beta item" }),
      ]);

      expect(new Set([first.id, second.id]).size).toBe(2);
      const files = await readdir(join(boardDirectory, "tasks"));
      expect(files).toHaveLength(2);
      expect(files.filter((name) => name.endsWith(".tmp"))).toEqual([]);
      await expect((await store.listTasks()).map(({ id }) => id)).toEqual(
        [first.id, second.id].sort((a, b) => a - b),
      );
    });

    it("changes nothing in the board config except next_id", async () => {
      await store.createTask({ title: "Record locations" });

      const config = await readFile(join(boardDirectory, "config.yml"), "utf8");
      expect(config).toBe(BOARD_CONFIG.replace("next_id: 1", "next_id: 2"));
    });

    it("keeps the board's next_id ahead of every allocated id", async () => {
      await Promise.all([
        new KanbanBoardStore(boardDirectory).createTask({
          title: "Alpha item",
        }),
        new KanbanBoardStore(boardDirectory).createTask({ title: "Beta item" }),
      ]);

      const highest = Math.max(
        ...(await store.listTasks()).map(({ id }) => id),
      );
      const config = await readFile(join(boardDirectory, "config.yml"), "utf8");
      expect(config).toContain(`next_id: ${highest + 1}`);
    });
  });

  describe("task file writes", () => {
    it("publishes a task file by rename, never by writing the target in place", async () => {
      const created = await store.createTask({
        body: "Original body.",
        title: "Record storage locations",
      });
      // A reader that opened the task file keeps reading the bytes it opened.
      // Renaming a finished file over the target is what gives that property;
      // truncating and rewriting the target in place takes it away.
      const reader = await open(created.file, "r");

      try {
        await store.appendTaskBody(created.id, "Appended line.");

        await expect(reader.readFile("utf8")).resolves.not.toContain(
          "Appended line.",
        );
      } finally {
        await reader.close();
      }
      await expect(readFile(created.file, "utf8")).resolves.toContain(
        "Appended line.",
      );
    });

    it("gives a rewritten task file a new identity, so no reader is overwritten", async () => {
      const created = await store.createTask({ title: "Record locations" });
      const before = await stat(created.file);

      await store.appendTaskBody(created.id, "Appended line.");

      expect((await stat(created.file)).ino).not.toBe(before.ino);
    });

    it("leaves no temporary file behind after a write", async () => {
      const created = await store.createTask({ title: "Record locations" });

      await store.appendTaskBody(created.id, "Appended line.");

      const files = await readdir(join(boardDirectory, "tasks"));
      expect(files.filter((name) => name.endsWith(".tmp"))).toEqual([]);
      expect(files).toEqual([created.file.split("/").pop()]);
    });

    it("replaces a target the writer cannot open for writing", async () => {
      // kanban-md makes a claimed task file read-only. A rename replaces it
      // anyway, because the permission that matters is on the directory.
      const created = await store.createTask({ title: "Record locations" });
      await chmod(created.file, 0o444);

      await writeFileAtomic(created.file, "---\nreplaced: true\n---\n");

      await expect(readFile(created.file, "utf8")).resolves.toBe(
        "---\nreplaced: true\n---\n",
      );
    });
  });

  describe("refusals", () => {
    it("refuses to touch a task another agent holds a live claim on", async () => {
      const created = await store.createTask({
        status: "todo",
        title: "Record locations",
      });
      await kanban(
        "edit",
        String(created.id),
        "--claim",
        "other-agent",
        "--status",
        "in-progress",
      );

      await expect(store.editTaskStatus(created.id, "done")).rejects.toThrow(
        /claimed by "other-agent"/,
      );
      await expect(
        store.appendTaskBody(created.id, "Appended line."),
      ).rejects.toThrow(/claimed by "other-agent"/);
    });

    it("refuses an unknown status and leaves the task file untouched", async () => {
      const created = await store.createTask({ title: "Record locations" });
      const before = await taskSource(created.id);

      await expect(
        store.editTaskStatus(created.id, "not-a-status"),
      ).rejects.toThrow('invalid status "not-a-status"');

      await expect(taskSource(created.id)).resolves.toBe(before);
    });

    it("refuses a create whose parent does not exist", async () => {
      await expect(
        store.createTask({ parent: 99, title: "Record locations" }),
      ).rejects.toThrow("dependency task #99 not found");
      await expect(readdir(join(boardDirectory, "tasks"))).resolves.toEqual([]);
    });
  });

  describe("columns that require a claim", () => {
    const CLAIMED_COLUMN_CONFIG = BOARD_CONFIG.replace(
      "    - name: in-progress\n",
      "    - name: in-progress\n      require_claim: true\n",
    );

    beforeEach(async () => {
      await writeFile(
        join(boardDirectory, "config.yml"),
        CLAIMED_COLUMN_CONFIG,
      );
    });

    it("refuses to move a task into a column that requires a claim", async () => {
      const created = await store.createTask({
        status: "todo",
        title: "Record locations",
      });
      const before = await taskSource(created.id);

      await expect(
        store.editTaskStatus(created.id, "in-progress"),
      ).rejects.toThrow('status "in-progress" requires a claim');

      await expect(taskSource(created.id)).resolves.toBe(before);
      // The CLI refuses the same unclaimed edit.
      await expect(
        kanban("edit", String(created.id), "--status", "in-progress"),
      ).rejects.toThrow(/requires --claim/);
    });

    it("refuses to move a task out of a column that requires a claim", async () => {
      const created = await store.createTask({
        status: "todo",
        title: "Record locations",
      });
      await kanban(
        "edit",
        String(created.id),
        "--claim",
        "other-agent",
        "--status",
        "in-progress",
      );
      await kanban("edit", String(created.id), "--release");

      await expect(store.editTaskStatus(created.id, "done")).rejects.toThrow(
        'status "in-progress" requires a claim',
      );
    });

    it("refuses to create a task directly into a column that requires a claim", async () => {
      await expect(
        store.createTask({ status: "in-progress", title: "Record locations" }),
      ).rejects.toThrow('status "in-progress" requires a claim');
      await expect(readdir(join(boardDirectory, "tasks"))).resolves.toEqual([]);
    });
  });

  it("lists non-archived tasks in id order", async () => {
    await store.createTask({ title: "Second item", status: "todo" });
    await store.createTask({ title: "First item", status: "todo" });
    const archived = await store.createTask({ title: "Retired item" });
    await kanban("delete", String(archived.id), "--yes");

    await expect((await store.listTasks()).map(({ id }) => id)).toEqual([1, 2]);
  });

  it("reads the board columns without the archived column", async () => {
    await expect(store.readBoardStatuses()).resolves.toEqual([
      "backlog",
      "todo",
      "in-progress",
      "done",
    ]);
  });
});
