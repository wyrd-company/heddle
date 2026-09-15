// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KanbanBoardStore } from "./index.js";
import { raiseNextId } from "./config.js";
import { interpretTaskFile } from "./task-file.js";

const execute = promisify(execFile);

const BOARD_CONFIG = (nextId: number): string => `version: 11
board:
    name: Sample Collection
tasks_dir: tasks
statuses:
    - name: backlog
      show_duration: false
    - name: todo
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
next_id: ${nextId}
`;

interface BoardSurvey {
  duplicateIds: number[];
  fileCount: number;
  ids: number[];
  nextId: number;
  titles: string[];
}

describe("concurrent kanban-md and Heddle creates", () => {
  let boardDirectory: string;
  let store: KanbanBoardStore;

  const tasksDirectory = (): string => join(boardDirectory, "tasks");

  /**
   * Pre-populates the board. The allocation window is two full-board reads, so
   * it only opens at a realistic board size; the live board is around 900
   * tasks and small boards hide the race entirely.
   */
  const populate = async (count: number): Promise<void> => {
    await mkdir(tasksDirectory(), { recursive: true });
    const now = new Date().toISOString();
    for (let id = 1; id <= count; id += 1) {
      await writeFile(
        join(tasksDirectory(), `${String(id).padStart(3, "0")}-seed-item.md`),
        `---\nid: ${id}\ntitle: Seed item ${id}\nstatus: todo\npriority: medium\ncreated: ${now}\nupdated: ${now}\nclass: standard\n---\n\nSeed body.\n`,
      );
    }
    await writeFile(
      join(boardDirectory, "config.yml"),
      BOARD_CONFIG(count + 1),
    );
  };

  const survey = async (): Promise<BoardSurvey> => {
    const names = (await readdir(tasksDirectory())).filter((name) =>
      name.endsWith(".md"),
    );
    const ids: number[] = [];
    const titles: string[] = [];
    for (const name of names) {
      const path = join(tasksDirectory(), name);
      const task = interpretTaskFile(await readFile(path, "utf8"), path);
      ids.push(task.id);
      titles.push(task.title);
    }
    const seen = new Set<number>();
    const duplicateIds = ids.filter((id) =>
      seen.has(id) ? true : (seen.add(id), false),
    );
    const config = await readFile(join(boardDirectory, "config.yml"), "utf8");
    return {
      duplicateIds,
      fileCount: names.length,
      ids,
      nextId: Number(/next_id:\s*(\d+)/.exec(config)?.[1]),
      titles,
    };
  };

  beforeEach(async () => {
    boardDirectory = await mkdtemp(join(tmpdir(), "board-race-test-"));
    store = new KanbanBoardStore(boardDirectory);
  });

  afterEach(async () => {
    await rm(boardDirectory, { force: true, recursive: true });
  });

  it.each([
    ["equal slugs", 300, 12, "Contended Item", "Contended Item"],
    ["distinct slugs", 300, 12, "Cli Authored", "Heddle Authored"],
  ])(
    "loses no task and issues no duplicate id with %s",
    async (_label, seed, rounds, cliTitle, heddleTitle) => {
      await populate(seed);
      const expected: string[] = [];

      for (let round = 0; round < rounds; round += 1) {
        const cliName = `${cliTitle} ${round}`;
        const heddleName = `${heddleTitle} ${round}`;
        // Both writers are released in the same tick, with no await between
        // them, so they occupy the allocation window together.
        const [, created] = await Promise.all([
          execute("kanban-md", [
            "--dir",
            boardDirectory,
            "create",
            cliName,
            "--status",
            "todo",
            "--json",
          ]),
          store.createTask({ status: "todo", title: heddleName }),
        ]);
        expect(created.title).toBe(heddleName);
        expected.push(cliName, heddleName);
      }

      const board = await survey();

      // Every task both writers reported as created is still on disk.
      for (const title of expected) {
        expect(board.titles).toContain(title);
      }
      expect(board.fileCount).toBe(seed + expected.length);
      expect(board.duplicateIds).toEqual([]);
      expect(board.nextId).toBeGreaterThan(Math.max(...board.ids));
    },
    240_000,
  );

  it("refuses to lower next_id a foreign writer already raised", async () => {
    await populate(300);
    // The caller computed its value from an earlier read; the board moved on.
    await writeFile(join(boardDirectory, "config.yml"), BOARD_CONFIG(900));

    await expect(raiseNextId(boardDirectory, 302)).resolves.toBe(900);

    await expect(
      readFile(join(boardDirectory, "config.yml"), "utf8"),
    ).resolves.toContain("next_id: 900");
  });

  it("yields its own id when another writer already carries it", async () => {
    // Two writers that do not share the in-process create queue, as two Heddle
    // processes would not. Distinct directory spellings resolve to one board.
    await populate(300);
    const other = new KanbanBoardStore(`${boardDirectory}/`);

    const results = await Promise.all([
      store.createTask({ status: "todo", title: "Alpha Contender" }),
      other.createTask({ status: "todo", title: "Zulu Contender" }),
    ]);

    const board = await survey();
    expect(new Set(results.map(({ id }) => id)).size).toBe(2);
    expect(board.duplicateIds).toEqual([]);
    expect(board.titles).toContain("Alpha Contender");
    expect(board.titles).toContain("Zulu Contender");
    expect(board.fileCount).toBe(302);
  }, 120_000);

  it("never lowers next_id below the highest id on disk", async () => {
    await populate(300);

    for (let round = 0; round < 12; round += 1) {
      await Promise.all([
        execute("kanban-md", [
          "--dir",
          boardDirectory,
          "create",
          `Cli Item ${round}`,
          "--json",
        ]),
        store.createTask({ title: `Heddle Item ${round}` }),
      ]);
      const board = await survey();
      // Checked every round: kanban-md trusts next_id without consulting the
      // files, so one low value at any point reissues a live id.
      expect(board.nextId).toBeGreaterThan(Math.max(...board.ids));
    }
  }, 240_000);
});
