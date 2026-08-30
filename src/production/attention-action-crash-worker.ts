// ---
// relationships:
//   verifies: heddle
// ---

import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import type { T3ThreadActivity } from "../control-plane/t3-control-plane-client.js";
import type { InstanceState } from "../persistence/index.js";
import {
  createProductionComposition,
  type ProductionT3Client,
} from "./composition.js";
import type { ProductionConfiguration } from "./configuration.js";

const [mode, kind, root] = process.argv.slice(2);
if (
  (mode !== "crash" && mode !== "resume") ||
  (kind !== "approval" && kind !== "user-input") ||
  root === undefined
) {
  throw new Error("mode, action kind, and root are required");
}

const attentionId = `${kind}-attention`;
const requestId = `${kind}-request`;
const threadId = "thread-one";
const attemptsPath = join(root, "attempts.jsonl");
const outcomePath = join(root, "outcome.json");

const configuration: ProductionConfiguration = {
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
    cliVersion: "0.91.0",
    driver: "codex",
    interactionMode: "default",
    model: "sample-model",
    runtimeMode: "auto-accept-edits",
    skillPointer: "skill://sample",
  },
  stageThresholds: { implement: 60_000 },
  stateDirectory: join(root, "state"),
  stopTimeoutMilliseconds: 1_000,
  t3: { accessToken: "access-token", baseUrl: "http://127.0.0.1:3999" },
};

const recordAcceptedResponse = async (
  response: "accept" | "reject" | Record<string, string | string[]>,
  commandId?: string,
): Promise<never> => {
  await appendFile(
    attemptsPath,
    `${JSON.stringify({ commandId, kind, requestId, response })}\n`,
  );
  if (mode === "resume") throw new Error("T3 response was replayed");
  const activity: T3ThreadActivity =
    kind === "approval"
      ? {
          kind: "approval.resolved",
          payload: { decision: response, requestId },
        }
      : {
          kind: "user-input.resolved",
          payload: { answers: response, requestId },
        };
  await writeFile(outcomePath, JSON.stringify(activity));
  process.exit(86);
};

const t3 = {
  dispatch: async () => ({ sequence: 1 }),
  getShell: async () => ({ threads: [] }),
  getThread: async () => {
    const serialized = await readFile(outcomePath, "utf8").catch(() => "");
    return {
      thread: {
        activities:
          serialized === "" ? [] : [JSON.parse(serialized) as T3ThreadActivity],
      },
    };
  },
  respondToApproval: async (
    _threadId: string,
    _requestId: string,
    decision: "accept" | "reject",
    commandId?: string,
  ) => recordAcceptedResponse(decision, commandId),
  respondToUserInput: async (
    _threadId: string,
    _requestId: string,
    answers: Record<string, string | string[]>,
    commandId?: string,
  ) => recordAcceptedResponse(answers, commandId),
} satisfies ProductionT3Client;

const composition = createProductionComposition({
  configuration,
  providerUsage: {
    readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
  },
  pushoverTransport: { send: async () => undefined },
  t3,
});

const initialState: InstanceState = {
  correlationTokens: {},
  flowcraftContext: {},
  handoffs: [],
  todoState: null,
};
if (composition.persistence.getInstance("instance-one") === undefined) {
  composition.persistence.createInstance("instance-one", initialState);
}
composition.persistence.writeReconcilerRuntime({
  boardStatus: "in-progress",
  instanceId: "instance-one",
  sessionKey: "session-one",
  stageId: "implement",
  state: "waiting",
  taskId: 1,
  threadId,
});
if (composition.attention.list().length === 0) {
  await composition.attention.raise({
    attentionId,
    instanceId: "instance-one",
    kind,
    message: `${kind} required`,
    ...(kind === "user-input"
      ? {
          questions: [
            {
              id: "direction",
              multiSelect: false,
              options: [{ label: "First" }, { label: "Second" }],
              question: "Choose a direction",
            },
          ],
        }
      : {}),
    requestId,
    sessionKey: "session-one",
    threadId,
  });
}
const attention = composition.attention.list()[0]!;
await composition.consoleActions.execute({
  action: attention.actions[0]!,
  ...(kind === "user-input" ? { answers: { direction: "First" } } : {}),
  attention,
});
process.stdout.write(
  JSON.stringify({
    completed: composition.persistence.effectCompleted(
      "console-attention-action",
      attentionId,
    ),
    unresolved: composition.attention.list().length,
  }),
);
await composition.close();
