// ---
// relationships:
//   verifies: heddle
// ---

import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import type { WorkflowMcpSessionBinding } from "../mcp-server/index.js";
import { escalationAttentionId } from "../mcp-server/escalation-contract.js";
import {
  createProductionComposition,
  type ProductionT3Client,
} from "./composition.js";
import type { ResolvedProductionConfiguration } from "./configuration.js";
import type { PushoverMessage, PushoverTransport } from "./durable-adapters.js";

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

const configuration: ResolvedProductionConfiguration = {
  adHocProject: {
    name: "Shared tasks",
    projectId: "workspace-project",
    workspaceRoot: root,
  },
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
  providerAliases: {
    primary: {
      model: "sample-model",
      providerDisplayName: "Workbench Alpha",
    },
  },
  products: [
    {
      name: "Sample product",
      repos: [
        {
          name: "sample-repository",
          repositoryRoot: join(root, "repository"),
        },
      ],
    },
  ],
  pushover: {
    apiUrl: "https://notify.invalid/messages",
    applicationToken: "application-token",
    consoleBaseUrl: "https://console.invalid/",
    userKey: "operator-key",
  },
  session: {
    baseRef: "main",
    defaultProviderAlias: "primary",
    defaultRuntimeMode: "auto-accept-edits",
    defaultSelection: {
      alias: "primary",
      driverKind: "codex",
      interactionMode: "default",
      model: {
        isCustom: false,
        name: "Sample Model",
        slug: "sample-model",
      },
      observedCliVersion: "0.91.0",
      providerDisplayName: "Workbench Alpha",
      providerInstanceId: "codex",
      runtimeMode: "auto-accept-edits",
    },
    resolvedSelections: [
      {
        alias: "primary",
        driverKind: "codex",
        interactionMode: "default",
        model: {
          isCustom: false,
          name: "Sample Model",
          slug: "sample-model",
        },
        observedCliVersion: "0.91.0",
        providerDisplayName: "Workbench Alpha",
        providerInstanceId: "codex",
        runtimeMode: "auto-accept-edits",
      },
    ],
    interactionMode: "default",
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
  registerWorkflowMcpProviderSession: async () => undefined,
} as ProductionT3Client;

const pushoverTransport: PushoverTransport = {
  send: async (message) =>
    appendFile(deliveriesPath, `${JSON.stringify(message)}\n`),
};

const composition = createProductionComposition({
  blueprintsRepositoryRoot: join(root, "blueprint-repository"),
  ...(mode === "crash-attention"
    ? {
        afterEscalationEffect: (effect: "attention" | "pushover") => {
          if (effect === "attention") process.exit(86);
        },
      }
    : {}),
  ...(mode === "crash-pushover"
    ? {
        afterPushoverTransportSuccess: () => process.exit(86),
      }
    : {}),
  configuration,
  providerUsage: {
    readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
  },
  pushoverTransport,
  t3,
  workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
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
  stage: { id: "implement", skills: [], tools: ["escalate", "answer"] },
  taskContext: { id: 17, title: "Example Item" },
  token: "correlation-token",
};
const controller = new globalThis.AbortController();
if (mode === "resume") {
  await composition.start();
} else {
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
}

const deliveries = (await readFile(deliveriesPath, "utf8").catch(() => ""))
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as PushoverMessage);
const stableAttentionId = escalationAttentionId(
  "task-17",
  "task-17:implement",
  "delivery-choice",
);
process.stdout.write(
  JSON.stringify({
    attentionIds: composition.attention
      .list()
      .map(({ attentionId }) => attentionId),
    deliveries,
    effectCompleted: composition.persistence.effectCompleted(
      "pushover",
      stableAttentionId,
    ),
    effectIntentRecorded: composition.persistence.effectIntentRecorded(
      "pushover",
      stableAttentionId,
    ),
    routeTypes: composition.persistence
      .replayEvents("task-17")
      .filter(({ type }) => type.startsWith("mcp:escalation-"))
      .map(({ type }) => type),
  }),
);
await composition.close();
