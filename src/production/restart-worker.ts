// ---
// relationships:
//   verifies: heddle
// ---

import { appendFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";

import type { T3DispatchCommand } from "../control-plane/t3-control-plane-client.js";
import type { T3ProviderCatalogReader } from "../control-plane/provider-selection.js";
import {
  createProductionComposition,
  type ProductionT3Client,
} from "./composition.js";
import type { ResolvedProductionConfiguration } from "./configuration.js";

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
) as ResolvedProductionConfiguration;
const recorded = (await readFile(commandLog, "utf8").catch(() => ""))
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as T3DispatchCommand);
const seen = new Set(recorded.map(({ commandId }) => commandId));
const t3: ProductionT3Client & T3ProviderCatalogReader = {
  dispatch: async (command: T3DispatchCommand) => {
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
    projects: recorded
      .filter(({ type }) => type === "project.create")
      .flatMap((command) =>
        typeof command.projectId === "string" &&
        typeof command.title === "string" &&
        typeof command.workspaceRoot === "string"
          ? [
              {
                id: command.projectId,
                title: command.title,
                workspaceRoot: command.workspaceRoot,
              },
            ]
          : [],
      ),
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
  readProviderCatalog: async () => [
    {
      availability: "available",
      displayName: configuration.session.defaultSelection.providerDisplayName,
      driverKind: configuration.session.defaultSelection.driverKind,
      enabled: true,
      installed: true,
      instanceId: configuration.session.defaultSelection.providerInstanceId,
      models: [configuration.session.defaultSelection.model],
      observedCliVersion:
        configuration.session.defaultSelection.observedCliVersion,
      state: "ready",
    },
  ],
  respondToApproval: async () => ({ sequence: 1 }),
  respondToUserInput: async () => ({ sequence: 1 }),
  registerWorkflowMcpProviderSession: async () => undefined,
};
const composition = createProductionComposition({
  blueprintsRepositoryRoot: join(
    dirname(configurationPath),
    "blueprint-repository",
  ),
  configuration,
  providerUsage: {
    readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
  },
  pushoverTransport: { send: async () => undefined },
  t3,
  workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
});
const statusWrites: Array<{ status: string; taskId: number }> = [];
const mirrorTaskStatus = composition.board.mirrorTaskStatus.bind(
  composition.board,
);
composition.board.mirrorTaskStatus = async (taskId, status) => {
  statusWrites.push({ status, taskId });
  await mirrorTaskStatus(taskId, status);
};
await composition.start();
await composition.scheduler.trigger();
const board = await composition.board.readBoard();
const instances = await composition.instances.listInstances();
process.stdout.write(
  JSON.stringify({
    attention: composition.persistence
      .listAttention()
      .map(({ payload }) => payload),
    commands: recorded.map(({ commandId, type }) => ({ commandId, type })),
    bindings: composition.persistence
      .listSessionRuntime()
      .map(({ binding }) => binding),
    instanceCount: composition.persistence.listInstances().length,
    instances,
    runtime: composition.persistence.listReconcilerRuntime(),
    statusWrites,
    taskStatus: board[0]?.status,
  }),
);
await composition.close();
