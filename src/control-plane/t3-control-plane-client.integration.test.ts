// ---
// relationships:
//   verifies: t3-control-plane-client
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

import { T3ControlPlaneClient } from "./t3-control-plane-client.js";

const t3Binary = process.env["HEDDLE_T3_INTEGRATION_BINARY"];
const cursorWrapper = resolve("bin/heddle-cursor-agent.mjs");
const cursorFixture = resolve("src/control-plane/fixtures/cursor-agent.mjs");
const exec = promisify(execFile);
const execChecked = (
  file: string,
  arguments_: string[],
  options: Parameters<typeof exec>[2] = {},
) => exec(file, arguments_, { ...options, timeout: 5_000 });

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
  new Promise((resolve, reject) => {
    let output = "";
    const inspect = (chunk: Buffer): void => {
      output += chunk.toString();
      const token = output.match(/Token:\s+(\S+)/)?.[1];
      if (token) resolve(token);
    };
    server.stdout?.on("data", inspect);
    server.stderr?.on("data", inspect);
    server.once("exit", (code) => {
      reject(
        new Error(`Isolated T3 server exited before pairing (code ${code})`),
      );
    });
  });

describe.skipIf(!t3Binary)(
  "T3ControlPlaneClient isolated T3 integration",
  () => {
    let scratch = "";
    let server: ChildProcess | undefined;
    let client: T3ControlPlaneClient;
    let projectId = "";
    let projectPath = "";
    let cursorRequestLog = "";

    beforeAll(async () => {
      scratch = await mkdtemp(join(tmpdir(), "heddle-t3-control-plane-"));
      const home = join(scratch, "t3-home");
      cursorRequestLog = join(scratch, "cursor-requests.jsonl");
      projectPath = join(scratch, "project");
      await mkdir(home, { recursive: true });
      await mkdir(join(home, "userdata"), { recursive: true });
      await writeFile(
        join(home, "userdata", "settings.json"),
        JSON.stringify({
          providers: {
            cursor: { enabled: true, binaryPath: cursorWrapper },
          },
        }),
      );
      await mkdir(projectPath, { recursive: true });
      await execChecked("git", ["init", "--quiet", "--initial-branch=main"], {
        cwd: projectPath,
      });
      await execChecked(
        "git",
        ["config", "user.email", "test@example.invalid"],
        {
          cwd: projectPath,
        },
      );
      await execChecked("git", ["config", "user.name", "Test Operator"], {
        cwd: projectPath,
      });
      await execChecked(
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
            HEDDLE_CURSOR_TEST_REQUEST_LOG: cursorRequestLog,
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
        "heddle-t3-client-integration",
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
    }, 20_000);

    afterAll(async () => {
      if (server && server.exitCode == null) {
        server.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          server?.once("exit", () => resolve());
          void delay(2_000).then(() => resolve());
        });
      }
      if (scratch) await rm(scratch, { recursive: true, force: true });
    });

    it("authenticates, dispatches, and polls a shell observation", async () => {
      const threadId = globalThis.crypto.randomUUID();
      const worktreePath = join(scratch, "thread-worktree");
      await execChecked(
        "git",
        [
          "worktree",
          "add",
          "--quiet",
          "-b",
          "integration/thread",
          worktreePath,
          "main",
        ],
        { cwd: projectPath },
      );

      await expect(
        client.dispatch({
          type: "thread.create",
          commandId: globalThis.crypto.randomUUID(),
          threadId,
          projectId,
          title: "Integration Thread",
          modelSelection: { instanceId: "claudeAgent", model: "default" },
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
          branch: "integration/thread",
          worktreePath,
          createdAt: new Date().toISOString(),
        }),
      ).resolves.toMatchObject({ sequence: expect.any(Number) });

      const observations = client.pollThread(threadId, 0);
      await expect(observations.next()).resolves.toMatchObject({
        done: false,
        value: { phase: "none", thread: { id: threadId } },
      });
      await observations.return(undefined);
    });

    it("starts a Cursor session through the packaged API-key wrapper and shim", async () => {
      const threadId = globalThis.crypto.randomUUID();
      const worktreePath = join(scratch, "cursor-thread-worktree");
      await execChecked(
        "git",
        [
          "worktree",
          "add",
          "--quiet",
          "-b",
          "integration/cursor-thread",
          worktreePath,
          "main",
        ],
        { cwd: projectPath },
      );
      await client.dispatch({
        type: "thread.create",
        commandId: globalThis.crypto.randomUUID(),
        threadId,
        projectId,
        title: "Cursor Integration Thread",
        modelSelection: { instanceId: "cursor", model: "default" },
        runtimeMode: "auto",
        interactionMode: "default",
        branch: "integration/cursor-thread",
        worktreePath,
        createdAt: new Date().toISOString(),
      });

      await client.dispatch(
        {
          type: "thread.turn.start",
          commandId: globalThis.crypto.randomUUID(),
          threadId,
          message: {
            messageId: globalThis.crypto.randomUUID(),
            role: "user",
            text: "Finish without changing files.",
            attachments: [],
          },
          modelSelection: { instanceId: "cursor", model: "default" },
          runtimeMode: "auto",
          interactionMode: "default",
          createdAt: new Date().toISOString(),
        },
        {
          driver: "cursor",
          cliVersion: "2026.08.11-e8db854",
          lifecycle: "independent",
        },
      );

      let completed = false;
      let lastObservation: Awaited<ReturnType<typeof client.observeThread>>;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const observation = await client.observeThread(threadId);
        lastObservation = observation;
        if (observation.phase === "completed") {
          completed = true;
          break;
        }
        await delay(100);
      }
      const requests = (await readFile(cursorRequestLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method?: string });
      expect(
        completed,
        JSON.stringify({ lastObservation, requests }, undefined, 2),
      ).toBe(true);
      expect(requests).toContainEqual({
        apiKeyInjected: true,
        arguments: ["acp"],
      });
      expect(requests.some(({ method }) => method === "session/new")).toBe(
        true,
      );
      expect(requests.some(({ method }) => method === "authenticate")).toBe(
        false,
      );
    }, 20_000);
  },
);
