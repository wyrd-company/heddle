// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KanbanBoardStore } from "./index.js";
import { withBoardLock } from "./board-lock.js";

const execute = promisify(execFile);

describe("board lock shared with kanban-md", () => {
  let boardDirectory: string;

  beforeEach(async () => {
    boardDirectory = await mkdtemp(join(tmpdir(), "board-lock-test-"));
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
    - name: done
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
`,
    );
  });

  afterEach(async () => {
    await rm(boardDirectory, { force: true, recursive: true });
  });

  it("blocks a real kanban-md create for as long as Heddle holds the lock", async () => {
    const heldForMilliseconds = 2_000;
    let cliFinishedAt: number | undefined;
    let attempt: Promise<void> | undefined;
    const startedAt = Date.now();

    await withBoardLock(boardDirectory, async () => {
      attempt = execute("kanban-md", [
        "--dir",
        boardDirectory,
        "create",
        "Contended Item",
        "--json",
      ]).then(() => {
        cliFinishedAt = Date.now();
      });
      await delay(heldForMilliseconds);
      // Still waiting on our lock after two seconds of real contention.
      expect(cliFinishedAt).toBeUndefined();
    });

    await attempt;
    expect(cliFinishedAt).toBeDefined();
    expect(cliFinishedAt! - startedAt).toBeGreaterThanOrEqual(
      heldForMilliseconds,
    );
  }, 60_000);

  it("releases the lock so a later create is not blocked", async () => {
    await withBoardLock(boardDirectory, async () => undefined);

    const startedAt = Date.now();
    await execute("kanban-md", [
      "--dir",
      boardDirectory,
      "create",
      "Free Item",
      "--json",
    ]);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
  }, 60_000);

  it("releases the lock when the work throws", async () => {
    await expect(
      withBoardLock(boardDirectory, async () => {
        throw new Error("work failed");
      }),
    ).rejects.toThrow("work failed");

    // A second acquisition would hang forever if the first had not released.
    await expect(
      withBoardLock(boardDirectory, async () => "acquired"),
    ).resolves.toBe("acquired");
  }, 60_000);

  it("makes a production board create wait for the board lock", async () => {
    // The production path must take the lock, not merely tolerate it. Hold the
    // lock from outside and assert createTask cannot finish until it is freed.
    const store = new KanbanBoardStore(boardDirectory);
    let created: number | undefined;
    let pending: Promise<unknown> | undefined;

    await withBoardLock(boardDirectory, async () => {
      pending = store.createTask({ title: "Waiting Item" }).then((task) => {
        created = task.id;
      });
      await delay(1_500);
      // A create that did not take the lock would already be done.
      expect(created).toBeUndefined();
      expect(
        (await readdir(join(boardDirectory, "tasks"))).filter((name) =>
          name.endsWith(".md"),
        ),
      ).toHaveLength(0);
    });

    await pending;
    expect(created).toBeDefined();
  }, 60_000);

  it("serializes a production board create against a real CLI create", async () => {
    const store = new KanbanBoardStore(boardDirectory);

    // Both writers released in the same tick, through the production path.
    const [, created] = await Promise.all([
      execute("kanban-md", [
        "--dir",
        boardDirectory,
        "create",
        "Cli Item",
        "--json",
      ]),
      store.createTask({ title: "Heddle Item" }),
    ]);

    const files = (await readdir(join(boardDirectory, "tasks"))).filter(
      (name) => name.endsWith(".md"),
    );
    expect(files).toHaveLength(2);
    expect(created.title).toBe("Heddle Item");
  }, 60_000);
});
