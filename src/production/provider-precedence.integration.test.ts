// ---
// relationships:
//   verifies: heddle
//   references: t3-headless
// ---

import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import { KanbanBoardAdapter } from "../board-adapter/index.js";
import {
  ProviderSelectionResolver,
  T3ControlPlaneClient,
} from "../control-plane/index.js";
import { prepareProductionFixture } from "./composition.test-support.js";
import { resolveProductionConfiguration } from "./configuration.js";
import {
  makeQualificationScratch,
  startIsolatedT3,
} from "./driver-qualification.test-support.js";
import { resolveStageSessionSelection } from "./stage-session-selection.js";

const t3Binary = process.env["HEDDLE_T3_INTEGRATION_BINARY"];
const operatorHome = process.env["HOME"] ?? "";

const EXECUTION = {
  displayName: "Workbench Alpha",
  driver: "claudeAgent",
  instanceId: "claude-execution",
} as const;
const REVIEW = {
  displayName: "Workbench Beta",
  driver: "claudeAgent",
  instanceId: "claude-review",
} as const;
const SECOND_DRIVER = {
  displayName: "Workbench Gamma",
  driver: "codex",
  instanceId: "codex-execution",
} as const;

const teardown: Array<() => Promise<void>> = [];

afterEach(async () => {
  const pending = teardown.splice(0, teardown.length).reverse();
  for (const release of pending) await release();
});

/**
 * Write the optional `provider-alias` scalar into the real task file, so the
 * override is read back through the production board reader rather than
 * injected as an already-normalized task.
 */
const setTaskFrontMatter = async (
  boardDirectory: string,
  taskId: number,
  line: string | undefined,
): Promise<void> => {
  const { join } = await import("node:path");
  const { readdir } = await import("node:fs/promises");
  const directory = join(boardDirectory, "tasks");
  // Task files are zero-padded, so match on the numeric prefix.
  const file = (await readdir(directory)).find((name) =>
    new RegExp(`^0*${taskId}-`).test(name),
  );
  if (file === undefined) throw new Error(`No task file for ${taskId}`);
  const path = join(directory, file);
  const source = await readFile(path, "utf8");
  const stripped = source.replace(/^provider-alias:.*\n/m, "");
  const updated =
    line === undefined
      ? stripped
      : stripped.replace(/^---\n/, `---\n${line}\n`);
  await writeFile(path, updated);
};

describe.skipIf(!t3Binary)(
  "provider alias precedence through the real board",
  () => {
    const arrange = async () => {
      const scratch = await makeQualificationScratch();
      teardown.push(scratch.cleanup);
      const fixture = await prepareProductionFixture();
      teardown.push(fixture.cleanup);

      const isolated = await startIsolatedT3({
        binary: t3Binary as string,
        home: operatorHome,
        providerInstances: [EXECUTION, REVIEW, SECOND_DRIVER],
        scratch: scratch.root,
      });
      teardown.push(isolated.stop);

      const client = new T3ControlPlaneClient({
        accessToken: isolated.accessToken,
        baseUrl: isolated.baseUrl,
      });
      const models = await (async () => {
        for (let attempt = 0; attempt < 60; attempt += 1) {
          const catalog = await client.readProviderCatalog();
          const ready = [EXECUTION, REVIEW, SECOND_DRIVER].every((instance) =>
            catalog.some(
              (row) =>
                row.instanceId === instance.instanceId &&
                row.state === "ready" &&
                row.models.length > 0,
            ),
          );
          if (ready) {
            return new Map(
              catalog.map((row) => [row.instanceId, row.models[0]?.slug ?? ""]),
            );
          }
          await delay(250);
        }
        throw new Error("Isolated T3 never finished provider discovery");
      })();

      const providerAliases = {
        execution: {
          model: models.get(EXECUTION.instanceId) ?? "",
          providerDisplayName: EXECUTION.displayName,
        },
        review: {
          model: models.get(REVIEW.instanceId) ?? "",
          providerDisplayName: REVIEW.displayName,
        },
        secondary: {
          model: models.get(SECOND_DRIVER.instanceId) ?? "",
          providerDisplayName: SECOND_DRIVER.displayName,
        },
      };
      const resolver = new ProviderSelectionResolver(providerAliases, client);
      const configuration = await resolveProductionConfiguration(
        {
          ...fixture.configuration,
          providerAliases,
          session: {
            ...fixture.configuration.session,
            defaultProviderAlias: "execution",
          },
          t3: { accessToken: isolated.accessToken, baseUrl: isolated.baseUrl },
        },
        resolver,
      );
      const board = new KanbanBoardAdapter(
        fixture.configuration.boardDirectory,
      );
      return { board, configuration, fixture, resolver };
    };

    const select = async (
      context: Awaited<ReturnType<typeof arrange>>,
      stageProviderAlias?: string,
    ) => {
      const task = await context.board.readTask(context.fixture.taskId);
      return resolveStageSessionSelection(
        {
          session: context.configuration.session,
          stageId: "implement",
          taskId: context.fixture.taskId,
          ...(stageProviderAlias === undefined ? {} : { stageProviderAlias }),
          ...(task.providerAlias === undefined
            ? {}
            : { taskProviderAlias: task.providerAlias }),
        },
        context.resolver,
      );
    };

    it("falls through to the configured default when nothing overrides it", async () => {
      const context = await arrange();
      const selection = await select(context);
      expect(selection.alias).toBe("execution");
      expect(selection.providerInstanceId).toBe(EXECUTION.instanceId);
    }, 180_000);

    it("uses the blueprint stage alias when the task declares none", async () => {
      const context = await arrange();
      const selection = await select(context, "review");
      expect(selection.alias).toBe("review");
      expect(selection.providerInstanceId).toBe(REVIEW.instanceId);
    }, 180_000);

    it("prefers the task front-matter alias over the stage alias", async () => {
      const context = await arrange();
      await setTaskFrontMatter(
        context.fixture.configuration.boardDirectory,
        context.fixture.taskId,
        "provider-alias: secondary",
      );
      const selection = await select(context, "review");
      expect(selection.alias).toBe("secondary");
      expect(selection.providerInstanceId).toBe(SECOND_DRIVER.instanceId);
      expect(selection.driverKind).toBe(SECOND_DRIVER.driver);
    }, 180_000);

    it("refuses a malformed task alias at the board reader", async () => {
      const context = await arrange();
      await setTaskFrontMatter(
        context.fixture.configuration.boardDirectory,
        context.fixture.taskId,
        "provider-alias: Not A Valid Alias",
      );
      await expect(
        context.board.readTask(context.fixture.taskId),
      ).rejects.toThrow(/provider-alias must be a lower-kebab scalar/);
    }, 180_000);

    it("refuses an unknown task alias without falling back", async () => {
      const context = await arrange();
      await setTaskFrontMatter(
        context.fixture.configuration.boardDirectory,
        context.fixture.taskId,
        "provider-alias: no-such-alias",
      );
      const failure = await select(context, "review").catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as { reason?: string }).reason).toBe(
        "provider-alias-not-allowed",
      );
      // No fallback: the stage alias and the configured default are not tried.
      expect(String(failure)).not.toContain(REVIEW.displayName);
      expect(String(failure)).not.toContain(EXECUTION.displayName);
    }, 180_000);
  },
);
