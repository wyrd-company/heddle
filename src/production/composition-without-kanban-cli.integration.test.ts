// ---
// relationships:
//   verifies: heddle
// ---

import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createProductionComposition } from "./composition.js";
import {
  prepareProductionFixture,
  SyntheticT3,
  type ProductionFixture,
} from "./composition.test-support.js";

/**
 * Builds a PATH that carries every executable the current PATH carries except
 * kanban-md, so the service runs with the board CLI genuinely absent rather
 * than merely unused.
 */
const pathWithoutKanban = async (
  directory: string,
): Promise<{ path: string; excluded: string[] }> => {
  const excluded: string[] = [];
  const linked = new Set<string>();
  for (const entry of (process.env["PATH"] ?? "").split(delimiter)) {
    if (entry === "") continue;
    let names: string[];
    try {
      names = await readdir(entry);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name === "kanban-md") {
        excluded.push(join(entry, name));
        continue;
      }
      if (linked.has(name)) continue;
      linked.add(name);
      await symlink(join(entry, name), join(directory, name)).catch(
        () => undefined,
      );
    }
  }
  return { excluded, path: directory };
};

describe("production composition without the kanban-md CLI", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("starts and reconciles a board with no kanban-md on PATH", async () => {
    const fixture: ProductionFixture = await prepareProductionFixture();
    const pathDirectory = await mkdtemp(join(tmpdir(), "heddle-no-kanban-"));
    const originalPath = process.env["PATH"];
    cleanup = async () => {
      process.env["PATH"] = originalPath;
      await rm(pathDirectory, { force: true, recursive: true });
      await fixture.cleanup();
    };

    const { excluded, path } = await pathWithoutKanban(pathDirectory);
    // The fixture is only meaningful if kanban-md was on PATH to begin with.
    expect(excluded.length).toBeGreaterThan(0);
    process.env["PATH"] = path;
    await expect(
      import("node:child_process").then(({ execFileSync }) =>
        execFileSync("sh", ["-c", "command -v kanban-md || printf absent"], {
          encoding: "utf8",
          env: { ...process.env, PATH: path },
        }).trim(),
      ),
    ).resolves.toBe("absent");

    const composition = createProductionComposition({
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
    });

    try {
      await composition.start();

      // The board was read, and the declared repository scope came with it.
      const board = await composition.board.readBoard();
      expect(board.map(({ id }) => id)).toContain(fixture.taskId);
      expect(board.find(({ id }) => id === fixture.taskId)?.repos).toEqual([
        "sample-repository",
      ]);
      expect(await composition.board.readBoardStatuses()).toContain(
        "in-progress",
      );
      expect(
        composition.persistence.listReconcilerRuntime().length,
      ).toBeGreaterThan(0);
    } finally {
      await composition.close();
    }
  }, 30_000);
});
