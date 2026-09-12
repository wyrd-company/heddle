// ---
// relationships:
//   verifies: heddle
//   references: t3-headless
// ---

import type { Buffer } from "node:buffer";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SqlitePersistence } from "../persistence/index.js";
import {
  bootstrapStageSession,
  steerStageSession,
} from "./session-bootstrap.js";
import { T3ControlPlaneClient } from "./t3-control-plane-client.js";
import { createWorkflowMcpHttpHandler } from "../mcp-server/workflow-mcp-handler.js";
import { startQualificationMcpServer } from "./fixtures/workflow-mcp-http.js";
import { safeT3StartupDiagnostic } from "../production/driver-qualification.test-support.js";
import {
  sampleHandoffTemplate,
  sampleTemplateAuthority,
} from "./session-bootstrap.test-support.js";

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

describe.skipIf(!t3Binary)("stage session isolated T3 integration", () => {
  let scratch = "";
  let server: ChildProcess | undefined;
  let client: T3ControlPlaneClient;
  let persistence: SqlitePersistence;
  let projectId = "";
  let projectPath = "";
  let templateRepositoryRoot = "";
  let requestLog = "";
  let mcpServer: Awaited<ReturnType<typeof startQualificationMcpServer>>;
  let mcpHandler: ReturnType<typeof createWorkflowMcpHttpHandler>;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "heddle-session-bootstrap-"));
    const home = join(scratch, "t3-home");
    const stateDirectory = join(scratch, "state");
    requestLog = join(scratch, "cursor-requests.jsonl");
    projectPath = join(scratch, "project");
    templateRepositoryRoot = join(scratch, "blueprint-repository");
    await mkdir(join(home, "userdata"), { recursive: true });
    await writeFile(
      join(home, "userdata", "settings.json"),
      JSON.stringify({
        providers: { cursor: { enabled: true, binaryPath: cursorWrapper } },
      }),
    );
    await mkdir(projectPath, { recursive: true });
    await mkdir(join(templateRepositoryRoot, "todo-templates"), {
      recursive: true,
    });
    await writeFile(
      join(templateRepositoryRoot, "todo-templates", "sample-prepare.json"),
      JSON.stringify({
        items: [{ id: "orient", text: "Orient on {{task.title}}" }],
      }),
    );
    await exec("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: projectPath,
    });
    await exec("git", ["config", "user.email", "test@example.invalid"], {
      cwd: projectPath,
    });
    await exec("git", ["config", "user.name", "Test Operator"], {
      cwd: projectPath,
    });
    await exec("git", ["commit", "--allow-empty", "--quiet", "-m", "initial"], {
      cwd: projectPath,
    });

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
          HEDDLE_CURSOR_TEST_PROMPT_DELAY_MS: "1000",
          HEDDLE_CURSOR_TEST_REQUEST_LOG: requestLog,
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
    await client.exchangePairingToken(pairingToken, "heddle-session-test");
    projectId = globalThis.crypto.randomUUID();
    await client.dispatch({
      type: "project.create",
      commandId: globalThis.crypto.randomUUID(),
      projectId,
      title: "Integration Project",
      workspaceRoot: projectPath,
      createdAt: new Date().toISOString(),
    });
    persistence = new SqlitePersistence({ stateDirectory });
    persistence.createInstance("instance-1", {
      correlationTokens: {},
      flowcraftContext: {
        awaitingNodeIds: ["prepare"],
        blueprintBlobHash: "a".repeat(40),
        blueprintPath: "blueprints/sample-process.json",
        completedOperations: {},
      },
      handoffs: [],
      todoState: null,
    });
    mcpServer = await startQualificationMcpServer();
    mcpHandler = createWorkflowMcpHttpHandler({
      persistence,
      lifecycle: {
        resume: async () => {
          throw new Error("Bootstrap fixture does not advance");
        },
      },
    });
    mcpServer.use(mcpHandler);
  }, 20_000);

  afterAll(async () => {
    await mcpHandler?.close();
    await mcpServer?.stop();
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

  it("steers a running stage with a second turn on the same thread", async () => {
    const providerContext = {
      cliVersion: "2026.08.11-e8db854",
      driver: "cursor",
      lifecycle: "independent" as const,
      providerInstanceId: "cursor",
    };
    const session = await bootstrapStageSession(
      {
        handoff: {
          skillPointer: "skill://prepare",
          stage: { kind: "standard", name: "prepare", priorStageOutputs: [] },
          taskContract: { title: "Prepare inventory" },
        },
        instanceId: "instance-1",
        interactionMode: "default",
        modelSelection: { instanceId: "cursor", model: "default" },
        projectId,
        providerContext,
        runtimeMode: "auto",
        sessionKey: "prepare-1",
        task: { id: 1, title: "Prepare inventory" },
        taskId: 1,
        title: "Prepare inventory",
        worktree: {
          baseRef: "main",
          branch: "integration/prepare",
          repositoryName: "sample-repository",
          repositoryRoot: projectPath,
          worktreeName: "task-prepare",
          worktreesRoot: join(scratch, "worktrees"),
        },
      },
      {
        activationEvents: persistence,
        persistence,
        templateAuthority: {
          ...sampleTemplateAuthority,
          repositoryRoot: templateRepositoryRoot,
        },
        resolveWorkflowMcpStageContract: async () => ({
          blueprintBlobHash: "a".repeat(40),
          blueprintPath: "blueprints/sample-process.json",
          dispositions: [
            { description: "Finish the preparation", name: "complete" },
          ],
          handoffTemplate: sampleHandoffTemplate,
          skills: [],
          stage: "prepare",
          todoTemplate: "sample-prepare",
          tools: ["advance", "get_task_context"],
        }),
        t3: client,
        workflowMcpEndpoint: mcpServer.endpoint,
      },
    );

    let running = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const observation = await client.observeThread(session.threadId);
      if (observation.phase === "failed") {
        throw new Error(
          `Stage session failed before steering: ${safeT3StartupDiagnostic(observation.thread.session?.lastError ?? "No provider diagnostic")}`,
        );
      }
      if (observation.phase === "running") {
        running = true;
        break;
      }
      await delay(50);
    }
    expect(running).toBe(true);
    await expect(
      steerStageSession(
        {
          interactionMode: "default",
          message: "Use the smaller container.",
          providerContext,
          runtimeMode: "auto",
          threadId: session.threadId,
        },
        { t3: client },
      ),
    ).resolves.toMatchObject({ sequence: expect.any(Number) });
    expect(JSON.stringify(await client.getThread(session.threadId))).toContain(
      "Use the smaller container.",
    );

    const requests = (await readFile(requestLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method?: string });
    expect(
      requests.filter(({ method }) => method === "session/prompt").length,
    ).toBeGreaterThanOrEqual(1);
  }, 20_000);
});
