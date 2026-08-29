// ---
// relationships:
//   verifies: heddle
//   references: t3-headless
// ---

import type { Buffer } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SessionObserver, steerStageSession } from "../control-plane/index.js";
import { T3ControlPlaneClient } from "../control-plane/t3-control-plane-client.js";
import { DispatchPacingGate } from "../pacing/index.js";
import { SqlitePersistence, type InstanceState } from "../persistence/index.js";
import { assignmentForChild } from "./delegation-state.js";
import { SubagentCoordinator } from "./coordinator.js";

const t3Binary = process.env["HEDDLE_T3_INTEGRATION_BINARY"];
const cursorWrapper = resolve("bin/heddle-cursor-agent.mjs");
const cursorFixture = resolve("src/control-plane/fixtures/cursor-agent.mjs");
const providerContext = {
  cliVersion: "2026.08.11-e8db854",
  driver: "cursor",
  lifecycle: "independent" as const,
};

const waitForServer = async (baseUrl: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await globalThis.fetch(`${baseUrl}/api/orchestration/shell`, {
        signal: globalThis.AbortSignal.timeout(500),
      });
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error("Isolated T3 server did not start within 10 seconds");
};

const readInitialPairingToken = (server: ChildProcess): Promise<string> =>
  new Promise((resolvePromise, reject) => {
    let output = "";
    const inspect = (chunk: Buffer): void => {
      output += chunk.toString();
      const token = output.match(/Token:\s+(\S+)/)?.[1];
      if (token) resolvePromise(token);
    };
    server.stdout?.on("data", inspect);
    server.stderr?.on("data", inspect);
    server.once("exit", (code) => {
      reject(new Error(`Isolated T3 exited before pairing (code ${code})`));
    });
  });

describe.skipIf(!t3Binary)(
  "subagent child-stop isolated T3 integration",
  () => {
    let scratch = "";
    let server: ChildProcess | undefined;
    let client: T3ControlPlaneClient;
    let persistence: SqlitePersistence;
    let projectId = "";
    let projectPath = "";

    beforeAll(async () => {
      scratch = await mkdtemp(join(tmpdir(), "heddle-subagent-"));
      const home = join(scratch, "t3-home");
      projectPath = join(scratch, "project");
      await mkdir(join(home, "userdata"), { recursive: true });
      await writeFile(
        join(home, "userdata", "settings.json"),
        JSON.stringify({
          providers: { cursor: { enabled: true, binaryPath: cursorWrapper } },
        }),
      );
      await mkdir(projectPath, { recursive: true });
      const port = 30_000 + Math.floor(Math.random() * 20_000);
      const baseUrl = `http://127.0.0.1:${port}`;
      server = spawn(
        t3Binary as string,
        [
          "serve",
          "--port",
          String(port),
          "--host",
          "127.0.0.1",
          "--base-dir",
          home,
          projectPath,
        ],
        {
          env: {
            ...process.env,
            HEDDLE_CURSOR_AGENT_BINARY: cursorFixture,
            HEDDLE_CURSOR_API_KEY: "isolated-api-key",
            HEDDLE_CURSOR_EXPECTED_API_KEY: "isolated-api-key",
            NO_COLOR: "1",
            T3CODE_HOME: home,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const [pairingToken] = await Promise.all([
        Promise.race([
          readInitialPairingToken(server),
          delay(10_000).then(() => {
            throw new Error("T3 emitted no pairing token within 10 seconds");
          }),
        ]),
        waitForServer(baseUrl),
      ]);
      client = new T3ControlPlaneClient({ baseUrl });
      await client.exchangePairingToken(pairingToken, "heddle-subagent-test");
      projectId = globalThis.crypto.randomUUID();
      await client.dispatch({
        type: "project.create",
        commandId: globalThis.crypto.randomUUID(),
        projectId,
        title: "Integration Project",
        workspaceRoot: projectPath,
        createdAt: new Date().toISOString(),
      });
      persistence = new SqlitePersistence({
        stateDirectory: join(scratch, "state"),
      });
    }, 20_000);

    afterAll(async () => {
      persistence?.close();
      if (server && server.exitCode == null) {
        server.kill("SIGTERM");
        await new Promise<void>((resolvePromise) => {
          server?.once("exit", () => resolvePromise());
          void delay(2_000).then(() => resolvePromise());
        });
      }
      if (scratch) await rm(scratch, { force: true, recursive: true });
    });

    it("records a stopped child and steers its parent through the observer hook", async () => {
      const parentThreadId = globalThis.crypto.randomUUID();
      const childThreadId = globalThis.crypto.randomUUID();
      const state: InstanceState = {
        correlationTokens: {
          "child-session": "child-token",
          "parent-session": "parent-token",
        },
        flowcraftContext: {
          awaitingNodeIds: ["implement"],
          blueprintBlobHash: "a".repeat(40),
          blueprintPath: "blueprints/sample.json",
          completedOperations: {},
          executionIds: [],
          nextTransitionNumber: 2,
          pendingAttentions: [],
          pendingTransition: null,
          serializedContext: "{}",
          status: "awaiting",
        },
        handoffs: [],
        todoState: {
          format: "heddle.todo-state",
          lists: [
            {
              assignments: [
                {
                  correlationToken: "child-token",
                  depth: 1,
                  model: "default",
                  operationId: "spawn-child",
                  parentSessionKey: "parent-session",
                  parentThreadId,
                  provider: "cursor",
                  rootItemId: "inspect",
                  sessionKey: "child-session",
                  status: "active",
                  threadId: childThreadId,
                },
              ],
              items: [
                { checked: false, id: "inspect", text: "Inspect sample" },
              ],
              sessionKey: "parent-session",
              stage: "implement",
              template: "sample-stage",
            },
          ],
          version: 1,
        },
      };
      persistence.createInstance("instance", state);
      for (const threadId of [parentThreadId, childThreadId]) {
        await client.dispatch({
          type: "thread.create",
          commandId: globalThis.crypto.randomUUID(),
          threadId,
          projectId,
          title: "Integration Thread",
          modelSelection: { instanceId: "cursor", model: "default" },
          runtimeMode: "auto",
          interactionMode: "default",
          branch: "main",
          worktreePath: projectPath,
          createdAt: new Date().toISOString(),
        });
      }
      await client.dispatch(
        {
          type: "thread.turn.start",
          commandId: globalThis.crypto.randomUUID(),
          threadId: childThreadId,
          message: {
            messageId: globalThis.crypto.randomUUID(),
            role: "user",
            text: "Complete the sample.",
            attachments: [],
          },
          modelSelection: { instanceId: "cursor", model: "default" },
          runtimeMode: "auto",
          interactionMode: "default",
          createdAt: new Date().toISOString(),
        },
        providerContext,
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await client.observeThread(childThreadId)).phase === "completed")
          break;
        if (attempt === 99) throw new Error("Child thread did not complete");
        await delay(100);
      }

      let observer: SessionObserver;
      const coordinator = new SubagentCoordinator({
        activeSessions: async () => [],
        bootstrapDependencies: { persistence, t3: client },
        observeChild: (target) => observer.observe(target),
        pacing: new DispatchPacingGate(
          {
            defaultProvider: "cursor",
            maxConcurrentSessions: 4,
            providerBudgets: {},
            subagents: { maxDepth: 2, maxFanOut: 2 },
            usageWindowHours: 5,
          },
          { readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }) },
        ),
        persistence,
        prepareSession: async () => {
          throw new Error("spawn is not used by this integration");
        },
        sessionTargetFor: () => {
          throw new Error("spawn is not used by this integration");
        },
        steerParent: async ({ assignment, message }) => {
          const notice = assignment.stopNotification!;
          await steerStageSession(
            {
              commandId: notice.commandId,
              createdAt: notice.createdAt,
              interactionMode: "default",
              message,
              messageId: notice.messageId,
              providerContext,
              runtimeMode: "auto",
              threadId: assignment.parentThreadId,
            },
            { t3: client },
          );
        },
      });
      observer = new SessionObserver({
        attention: { has: async () => false, raise: async () => undefined },
        childStops: coordinator,
        escalations: {
          pendingEscalations: () => [],
          requireNoPendingForSession: () => undefined,
        },
        persistence,
        t3: client,
        thresholds: {
          endedMilliseconds: 60_000,
          failedMilliseconds: 60_000,
          stalledMilliseconds: 60_000,
        },
      });

      await observer.observe({
        instanceId: "instance",
        sessionKey: "child-session",
        threadId: childThreadId,
      });

      expect(JSON.stringify(await client.getThread(parentThreadId))).toContain(
        "assigned todo subtree inspect",
      );
      expect(
        assignmentForChild(
          persistence.getInstance("instance")!,
          "child-session",
        ).assignment,
      ).toMatchObject({
        status: "stopped",
        stopNotification: { status: "completed" },
      });
    }, 30_000);
  },
);
