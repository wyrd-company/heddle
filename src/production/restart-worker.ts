// ---
// relationships:
//   verifies: heddle
// ---

import { appendFile, readFile } from "node:fs/promises";

import type { HarnessToolTimeoutLaunchInput } from "../control-plane/index.js";
import type {
  T3DispatchCommand,
  T3ProviderDispatchContext,
} from "../control-plane/t3-control-plane-client.js";
import {
  createProductionComposition,
  type ProductionT3Client,
} from "./composition.js";
import type { ProductionConfiguration } from "./configuration.js";

const [mode, configurationPath, commandLog] = process.argv.slice(2);
if (
  (mode !== "crash-after-activation" && mode !== "restart") ||
  configurationPath === undefined ||
  commandLog === undefined
) {
  throw new Error("mode, configuration path, and command log are required");
}

const configuration = JSON.parse(
  await readFile(configurationPath, "utf8"),
) as ProductionConfiguration;
const recorded = (await readFile(commandLog, "utf8").catch(() => ""))
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as T3DispatchCommand);
const seen = new Set(recorded.map(({ commandId }) => commandId));
const t3: ProductionT3Client = {
  applyHarnessToolTimeout: async (_input: HarnessToolTimeoutLaunchInput) =>
    undefined,
  dispatch: async (
    command: T3DispatchCommand,
    _context?: T3ProviderDispatchContext,
  ) => {
    if (!seen.has(command.commandId)) {
      seen.add(command.commandId);
      recorded.push(command);
      await appendFile(commandLog, `${JSON.stringify(command)}\n`);
    }
    if (
      mode === "crash-after-activation" &&
      command.type === "thread.turn.start"
    ) {
      process.exit(87);
    }
    return { sequence: recorded.length };
  },
  getShell: async () => ({
    threads: recorded
      .filter(({ type }) => type === "thread.create")
      .flatMap(({ threadId }) =>
        threadId === undefined
          ? []
          : [
              {
                id: threadId,
                latestTurn: { state: "running" },
                session: { status: "running" },
              },
            ],
      ),
  }),
  getThread: async () => ({ thread: { activities: [] } }),
  respondToApproval: async () => ({ sequence: 1 }),
  respondToUserInput: async () => ({ sequence: 1 }),
};
const composition = createProductionComposition({
  configuration,
  providerUsage: {
    readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
  },
  pushoverTransport: { send: async () => undefined },
  t3,
});
await composition.start();
await composition.scheduler.trigger();
const board = await composition.board.readBoard();
process.stdout.write(
  JSON.stringify({
    commands: recorded.map(({ commandId, type }) => ({ commandId, type })),
    instanceCount: composition.persistence.listInstances().length,
    runtime: composition.persistence.listReconcilerRuntime(),
    taskStatus: board[0]?.status,
  }),
);
await composition.close();
