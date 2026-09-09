// ---
// relationships:
//   verifies: heddle
// ---

import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { toNodeHandler } from "@modelcontextprotocol/node";

import { SqlitePersistence } from "../persistence/index.js";
import type { LifecycleSnapshot } from "../engine/index.js";
import type { WorkflowMcpLifecycle } from "./types.js";
import {
  EscalationCoordinator,
  type EscalationAttentionQueue,
  type EscalationAnswers,
  type EscalationAttention,
  type EscalationQuestion,
  type SessionEscalation,
} from "./escalation-coordinator.js";
import { createWorkflowMcpHttpHandler } from "./workflow-mcp-handler.js";

const scratchDirectories: string[] = [];
const servers: HttpServer[] = [];
const clients: Client[] = [];

const storedHandoff = (
  sessionKey: string,
  token: string,
  tools: string[],
  parentSessionKey?: string,
) => ({
  correlationToken: token,
  handoff: JSON.stringify({
    format: "heddle.stage-handoff",
    stage: { name: "assess", skills: [] },
    taskContract: { id: 41, title: "Assess a sample" },
    version: 1,
  }),
  kind: "stage-handoff",
  ...(parentSessionKey === undefined ? {} : { parentSessionKey }),
  sessionKey,
  workflowMcp: {
    blueprintBlobHash: "a".repeat(40),
    blueprintPath: "blueprints/sample-process.json",
    dispositions: [
      { description: "Complete the assessment", name: "complete" },
    ],
    handoffTemplate: {
      commitSha: "b".repeat(40),
      path: "handoff-templates/sample.md",
    },
    skills: [],
    stage: "assess",
    todoTemplate: "sample-assess",
    tools,
  },
});

export const createEscalationInstance = (
  persistence: SqlitePersistence,
  instanceId: string,
  sessions: Array<{
    parentSessionKey?: string;
    sessionKey: string;
    token: string;
    tools: string[];
  }>,
) =>
  persistence.createInstance(instanceId, {
    correlationTokens: Object.fromEntries(
      sessions.map(({ sessionKey, token }) => [sessionKey, token]),
    ),
    flowcraftContext: {
      awaitingNodeIds: ["assess"],
      blueprintBlobHash: "a".repeat(40),
      blueprintPath: "blueprints/sample-process.json",
      completedOperations: {},
    },
    handoffs: sessions.map(({ parentSessionKey, sessionKey, token, tools }) =>
      storedHandoff(sessionKey, token, tools, parentSessionKey),
    ),
    todoState: null,
  });

const listen = async (
  handler: ReturnType<typeof createWorkflowMcpHttpHandler>,
): Promise<globalThis.URL> => {
  const nodeHandler = toNodeHandler(handler);
  const server = createServer((request, response) => {
    void nodeHandler(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("HTTP test server did not bind a TCP port");
  }
  return new globalThis.URL(`http://127.0.0.1:${address.port}/mcp`);
};

export const connectEscalationClient = async (
  url: globalThis.URL,
  token: string,
  name: string,
) => {
  const client = new Client({ name, version: "1.0.0" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      authProvider: { token: async () => token },
    }),
  );
  return client;
};

export const sampleEscalationQuestions: EscalationQuestion[] = [
  {
    id: "delivery-window",
    options: [
      {
        description: "Continue with the current delivery window",
        id: "continue",
        label: "Continue",
      },
      {
        description: "Wait for the next delivery window",
        id: "wait",
        label: "Wait",
      },
    ],
    prompt: "Which delivery window should be used?",
  },
];

export const sampleEscalationAnswer: EscalationAnswers = {
  "delivery-window": "continue",
};

export const createEscalationFixture = async (
  options: {
    attention?: EscalationAttentionQueue["raise"];
    resume?: WorkflowMcpLifecycle["resume"];
  } = {},
) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "heddle-escalation-"));
  scratchDirectories.push(stateDirectory);
  const persistence = new SqlitePersistence({ stateDirectory });
  const attentions: EscalationAttention[] = [];
  const notifications: EscalationAttention[] = [];
  const parentEscalations: SessionEscalation[] = [];
  const lifecycleResumes: Parameters<WorkflowMcpLifecycle["resume"]>[0][] = [];
  const deliveredAnswers: Parameters<
    NonNullable<
      ConstructorParameters<typeof EscalationCoordinator>[0]["delivery"]
    >["deliver"]
  >[0][] = [];
  const decisionRecords: Parameters<
    NonNullable<
      ConstructorParameters<typeof EscalationCoordinator>[0]["decisionLog"]
    >["record"]
  >[0][] = [];
  const coordinator = new EscalationCoordinator({
    attention: {
      raise: async (value) => {
        attentions.push(value);
        await options.attention?.(value);
      },
    },
    decisionLog: {
      record: async (value) => void decisionRecords.push(value),
    },
    delivery: {
      deliver: async (value) => void deliveredAnswers.push(value),
    },
    session: { steer: async (value) => void parentEscalations.push(value) },
    persistence,
    pushover: { send: async (value) => void notifications.push(value) },
    now: () => "2026-01-01T00:00:00.000Z",
  });
  const handler = createWorkflowMcpHttpHandler({
    escalationCoordinator: coordinator,
    lifecycle: {
      resume: async (input) => {
        lifecycleResumes.push(input);
        if (options.resume !== undefined) return options.resume(input);
        return {
          instanceId: input.instanceId,
          status: "completed",
        } as LifecycleSnapshot;
      },
    },
    persistence,
  });
  const url = await listen(handler);
  return {
    attentions,
    coordinator,
    decisionRecords,
    deliveredAnswers,
    handler,
    lifecycleResumes,
    notifications,
    parentEscalations,
    persistence,
    stateDirectory,
    url,
  };
};

export const cleanupEscalationFixtures = async (): Promise<void> => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) =>
              error === undefined ? resolve() : reject(error),
            ),
          ),
      ),
  );
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
};
