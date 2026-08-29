// ---
// relationships:
//   verifies: heddle
// ---

import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import type { WorkflowMcpSessionBinding } from "../mcp-server/index.js";
import {
  createProductionComposition,
  type ProductionT3Client,
} from "./composition.js";
import type { ProductionConfiguration } from "./configuration.js";

const [mode, root, deliveriesPath] = process.argv.slice(2);
if (
  (mode !== "crash-attention" &&
    mode !== "crash-pushover" &&
    mode !== "resume") ||
  root === undefined ||
  deliveriesPath === undefined
) {
  throw new Error("mode, root, and deliveries path are required");
}

const configuration: ProductionConfiguration = {
  boardDirectory: join(root, "board"),
  cadenceMilliseconds: 60_000,
  observationThresholds: {
    endedMilliseconds: 60_000,
    failedMilliseconds: 60_000,
    stalledMilliseconds: 60_000,
  },
  pacing: {
    defaultProvider: "codex",
    maxConcurrentSessions: 1,
    providerBudgets: {},
    subagents: { maxDepth: 1, maxFanOut: 1 },
    usageWindowHours: 5,
  },
  projectId: "workspace-project",
  pushover: {
    apiUrl: "https://notify.invalid/messages",
    applicationToken: "application-token",
    consoleBaseUrl: "https://console.invalid/",
    userKey: "operator-key",
  },
  repositoryRoot: join(root, "repository"),
  session: {
    baseRef: "main",
    cliVersion: "0.91.0",
    driver: "codex",
    interactionMode: "default",
    model: "sample-model",
    repositoryName: "sample-repository",
    runtimeMode: "auto-accept-edits",
    skillPointer: "skill://sample",
  },
  stageThresholds: { implement: 60_000 },
  stateDirectory: join(root, "state"),
  stopTimeoutMilliseconds: 1_000,
  t3: { accessToken: "access-token", baseUrl: "http://127.0.0.1:3999" },
};

const t3 = {
  dispatch: async () => ({ sequence: 1 }),
  getShell: async () => ({ threads: [] }),
  getThread: async () => ({ thread: { activities: [] } }),
  respondToApproval: async () => ({ sequence: 1 }),
  respondToUserInput: async () => ({ sequence: 1 }),
} as ProductionT3Client;

const composition = createProductionComposition({
  ...(mode === "resume"
    ? {}
    : {
        afterEscalationEffect: (effect: "attention" | "pushover") => {
          if (effect === mode.replace("crash-", "")) process.exit(86);
        },
      }),
  configuration,
  providerUsage: {
    readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
  },
  pushoverTransport: {
    send: async ({ stableId }) => appendFile(deliveriesPath, `${stableId}\n`),
  },
  t3,
});

let instance = composition.persistence.getInstance("task-17");
if (instance === undefined) {
  instance = composition.persistence.createInstance("task-17", {
    correlationTokens: {},
    flowcraftContext: {},
    handoffs: [],
    todoState: null,
  });
}
composition.persistence.writeReconcilerRuntime({
  boardStatus: "in-progress",
  instanceId: "task-17",
  sessionKey: "task-17:implement",
  stageId: "implement",
  state: "waiting",
  taskId: 17,
  threadId: "thread-17",
});
const binding: WorkflowMcpSessionBinding = {
  dispositions: [],
  instance,
  sessionKey: "task-17:implement",
  stage: { id: "implement", tools: ["escalate", "answer"] },
  taskContext: { id: 17, title: "Example Item" },
  token: "correlation-token",
};
const controller = new globalThis.AbortController();
if (mode === "resume") {
  globalThis.setTimeout(
    () => controller.abort(new Error("probe complete")),
    50,
  );
}
try {
  await composition.escalation.escalate(
    binding,
    {
      escalationId: "delivery-choice",
      questions: [
        {
          id: "decision",
          options: [
            { description: "Use route A", id: "a", label: "Route A" },
            { description: "Use route B", id: "b", label: "Route B" },
          ],
          prompt: "Choose a route",
        },
      ],
    },
    controller.signal,
  );
} catch (error) {
  if (mode !== "resume" || !controller.signal.aborted) throw error;
}

const deliveries = (await readFile(deliveriesPath, "utf8").catch(() => ""))
  .split("\n")
  .filter(Boolean);
process.stdout.write(
  JSON.stringify({
    attentionCount: composition.attention.list().length,
    deliveries,
    routeTypes: composition.persistence
      .replayEvents("task-17")
      .filter(({ type }) => type.startsWith("mcp:escalation-"))
      .map(({ type }) => type),
  }),
);
await composition.close();
