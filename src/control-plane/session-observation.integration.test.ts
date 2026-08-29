// ---
// relationships:
//   verifies: heddle
//   references:
//     - cursor-headless
//     - t3-session-visibility
// ---

import type { Buffer } from "node:buffer";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createConsoleAttention } from "../console/attention-contract.js";
import { createConsoleServer } from "../console/server.js";
import type {
  ConsoleAttention,
  ConsoleBoard,
  ConsoleStateSource,
} from "../console/types.js";
import type { InstanceState } from "../persistence/index.js";
import { SqlitePersistence } from "../persistence/index.js";
import { SessionObserver } from "./session-observation.js";
import type {
  SessionObservationAttention,
  SessionObservationTarget,
} from "./session-observation-types.js";
import { T3ControlPlaneClient } from "./t3-control-plane-client.js";

const t3Binary = process.env["HEDDLE_T3_INTEGRATION_BINARY"];
const cursorWrapper = resolve("bin/heddle-cursor-agent.mjs");
const cursorFixture = resolve("src/control-plane/fixtures/cursor-agent.mjs");
const exec = promisify(execFile);

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
      reject(
        new Error(`Isolated T3 server exited before pairing (code ${code})`),
      );
    });
  });

const lifecycleState = (terminal: boolean): InstanceState => ({
  correlationTokens: {},
  flowcraftContext: {
    awaitingNodeIds: terminal ? [] : ["mix"],
    blueprintBlobHash: "a".repeat(40),
    blueprintPath: "blueprints/sample.json",
    completedOperations: terminal
      ? {
          "mcp:advance:mix-one": {
            awaitingNodeIds: [],
            executionIds: [],
            requestFingerprint: "complete",
            status: "completed",
            transitionId: "sample:2",
          },
        }
      : {},
    executionIds: [],
    nextTransitionNumber: 2,
    pendingAttentions: [],
    pendingTransition: null,
    serializedContext: "{}",
    status: terminal ? "completed" : "awaiting",
  },
  handoffs: [],
  todoState: null,
});

describe.skipIf(!t3Binary)(
  "session observation isolated T3 integration",
  () => {
    let scratch = "";
    let server: ChildProcess | undefined;
    let client: T3ControlPlaneClient;
    let persistence: SqlitePersistence;
    let projectId = "";
    let projectPath = "";
    const attention: SessionObservationAttention[] = [];

    beforeAll(async () => {
      scratch = await mkdtemp(join(tmpdir(), "heddle-observation-"));
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
      await exec("git", ["init", "--quiet", "--initial-branch=main"], {
        cwd: projectPath,
      });
      await exec("git", ["config", "user.email", "test@example.invalid"], {
        cwd: projectPath,
      });
      await exec("git", ["config", "user.name", "Test Operator"], {
        cwd: projectPath,
      });
      await exec(
        "git",
        ["commit", "--allow-empty", "--quiet", "-m", "initial"],
        {
          cwd: projectPath,
        },
      );

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
      await client.exchangePairingToken(
        pairingToken,
        "heddle-observation-test",
      );
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

    const observer = () =>
      new SessionObserver({
        attention: {
          async has(attentionId) {
            return attention.some((entry) => entry.attentionId === attentionId);
          },
          async raise(entry) {
            attention.push(entry);
          },
        },
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

    const createThread = async (
      instanceId: string,
      prompt?: "REQUEST_APPROVAL" | "REQUEST_USER_INPUT",
    ): Promise<SessionObservationTarget> => {
      persistence.createInstance(instanceId, lifecycleState(false));
      const threadId = globalThis.crypto.randomUUID();
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
      if (prompt) {
        await client.dispatch(
          {
            type: "thread.turn.start",
            commandId: globalThis.crypto.randomUUID(),
            threadId,
            message: {
              messageId: globalThis.crypto.randomUUID(),
              role: "user",
              text: prompt,
              attachments: [],
            },
            modelSelection: { instanceId: "cursor", model: "default" },
            runtimeMode: "auto",
            interactionMode: "default",
            createdAt: new Date().toISOString(),
          },
          {
            cliVersion: "2026.08.11-e8db854",
            driver: "cursor",
            lifecycle: "independent",
          },
        );
      }
      return { instanceId, sessionKey: "mix-one", threadId };
    };

    const awaitAttention = async (
      sessionObserver: SessionObserver,
      target: SessionObservationTarget,
      kind: "approval" | "user-input",
    ): Promise<SessionObservationAttention> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const result = await sessionObserver.observe(target);
        const found = result.attentions.find((entry) => entry.kind === kind);
        if (found) return found;
        await delay(100);
      }
      throw new Error(`Isolated T3 did not expose pending ${kind}`);
    };

    it("projects and answers approval and user-input through the pinned T3 client", async () => {
      const sessionObserver = observer();
      const approvalTarget = await createThread(
        "sample-approval",
        "REQUEST_APPROVAL",
      );
      const approval = await awaitAttention(
        sessionObserver,
        approvalTarget,
        "approval",
      );
      await sessionObserver.answerApproval(
        approvalTarget,
        approval.requestId!,
        "accept",
      );

      const questionTarget = await createThread(
        "sample-question",
        "REQUEST_USER_INPUT",
      );
      const question = await awaitAttention(
        sessionObserver,
        questionTarget,
        "user-input",
      );
      await sessionObserver.answerUserInput(
        questionTarget,
        question.requestId!,
        { quantity: "Small" },
      );

      expect(
        (await client.getShell()).threads.find(
          ({ id }) => id === approvalTarget.threadId,
        )?.hasPendingApprovals,
      ).toBe(false);
      expect(
        (await client.getShell()).threads.find(
          ({ id }) => id === questionTarget.threadId,
        )?.hasPendingUserInput,
      ).toBe(false);
    }, 30_000);

    it("dispatches one pinned T3 approval through its offered console action", async () => {
      const sessionObserver = observer();
      const approvalTarget = await createThread(
        "sample-console-approval",
        "REQUEST_APPROVAL",
      );
      const approval = await awaitAttention(
        sessionObserver,
        approvalTarget,
        "approval",
      );
      if (approval.requestId === undefined) {
        throw new Error("Pinned T3 approval has no request identity");
      }
      const entry = createConsoleAttention({
        actions: (["accept", "reject"] as const).map((decision) => ({
          actionId: decision,
          contract: {
            decision,
            instanceId: approval.instanceId,
            kind: "t3.approval.respond" as const,
            requestId: approval.requestId!,
            sessionKey: approval.sessionKey,
            threadId: approval.threadId,
          },
          input: { kind: "none" as const },
          label: decision === "accept" ? "Accept" : "Reject",
        })),
        attentionId: approval.attentionId,
        instanceId: approval.instanceId,
        kind: "approval",
        message: approval.message,
        scope: "task:41",
        taskId: 41,
      });
      let current: ConsoleAttention[] = [entry];
      const board: ConsoleBoard = {
        readBoard: async () => [],
        readBoardStatuses: async () => [],
        setEpicInProgress: async () => undefined,
      };
      const state: ConsoleStateSource = {
        listAttention: async () => current,
        listEvents: async () => [],
        listInstances: async () => [],
        readLifecycle: async () => {
          throw new Error("unexpected lifecycle read");
        },
      };
      const consoleServer = createConsoleServer({
        actions: {
          execute: async ({ action }) => {
            if (action.contract.kind !== "t3.approval.respond") {
              throw new Error("unexpected console action authority");
            }
            await sessionObserver.answerApproval(
              {
                instanceId: action.contract.instanceId,
                sessionKey: action.contract.sessionKey,
                threadId: action.contract.threadId,
              },
              action.contract.requestId,
              action.contract.decision,
            );
            current = [];
          },
        },
        board,
        state,
      });
      try {
        await new Promise<void>((resolvePromise) =>
          consoleServer.listen(0, "127.0.0.1", resolvePromise),
        );
        const port = (consoleServer.address() as AddressInfo).port;
        const response = await globalThis.fetch(
          `http://127.0.0.1:${port}/api/attention/${entry.attentionId}/actions/accept`,
          {
            body: JSON.stringify({ fingerprint: entry.fingerprint }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        );

        expect(response.status).toBe(204);
        expect(current).toEqual([]);
        expect(
          (await client.getShell()).threads.find(
            ({ id }) => id === approvalTarget.threadId,
          )?.hasPendingApprovals,
        ).toBe(false);
      } finally {
        await new Promise<void>((resolvePromise, reject) =>
          consoleServer.close((error) =>
            error === undefined ? resolvePromise() : reject(error),
          ),
        );
      }
    }, 20_000);

    it("archives only after recorded lifecycle terminality and removes the thread from the normal shell", async () => {
      const sessionObserver = observer();
      const archiveTarget = await createThread("sample-archive");

      await expect(
        sessionObserver.observe(archiveTarget),
      ).resolves.toMatchObject({
        archiveDispatched: false,
      });
      expect(
        (await client.getShell()).threads.some(
          ({ id }) => id === archiveTarget.threadId,
        ),
      ).toBe(true);

      persistence.updateInstance(
        archiveTarget.instanceId,
        lifecycleState(true),
      );
      await expect(
        sessionObserver.observe(archiveTarget),
      ).resolves.toMatchObject({
        archiveDispatched: true,
      });
      expect(
        (await client.getShell()).threads.some(
          ({ id }) => id === archiveTarget.threadId,
        ),
      ).toBe(false);
      await expect(
        sessionObserver.observe(archiveTarget),
      ).resolves.toMatchObject({
        archiveDispatched: false,
        phase: "absent",
      });
    }, 20_000);
  },
);
