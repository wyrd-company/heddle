// ---
// relationships:
//   verifies: command-line-interface
// ---
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FakeT3Server } from "../src/t3code/test/support/fake-server.js";
import {
  makeShellProject,
  makeShellSnapshot,
  makeShellThread,
  makeSnapshot,
  makeThread,
} from "../src/t3code/test/support/thread-fixtures.js";
import type { ResolvedServiceConfig } from "../src/service/config.js";
import { startService } from "../src/service/service.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function launch(config: string): ChildProcess {
  const child = spawn(
    process.execPath,
    [join(process.cwd(), "dist/cli.js"), "start", "--config", config],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  return child;
}
async function packagedStarted(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "",
      errors = "";
    child.stderr?.on("data", (chunk) => {
      errors += String(chunk);
    });
    child.once("exit", (code, signal) => {
      reject(
        new Error(
          `packaged service exited (${String(code)}/${String(signal)}): ${errors}`,
        ),
      );
    });
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("Heddle started;")) resolve(output);
    });
  });
}
async function processExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) =>
    child.once("exit", () => {
      resolve();
    }),
  );
}

it("reopens the production composition and recovers the same paused pass", async () => {
  const root = mkdtempSync(join(tmpdir(), "service-recovery-"));
  roots.push(root);
  const blueprints = join(root, "blueprints");
  mkdirSync(blueprints);
  writeFileSync(
    join(blueprints, "sample-process.yml"),
    `id: sample-process\nkind: process\nnodes:\n  inspect:\n    uses: pass\n    params:\n      prompt: { inline: Inspect the sample. }\n      handoff:\n        type: object\n        description: Submit the result.\n        properties:\n          accepted: { type: boolean }\n        required: [accepted]\n  finish:\n    uses: terminal-result\n    params:\n      value: done\nedges:\n  - from: inspect\n    to: finish\n    when: result.output.handoff\n  - from: inspect\n    to: finish\n    when: result.output.escalate\n  - from: inspect\n    to: finish\n    when: result.output.timeout\n  - from: inspect\n    to: finish\n    when: result.output.idle\n  - from: inspect\n    to: finish\n    when: result.output.turnEnded\n  - from: inspect\n    to: finish\n    when: result.output.overridden\n`,
  );
  const server = await FakeT3Server.start({ token: "fixture-token" });
  const projects = [makeShellProject({ workspaceRoot: root })];
  const threads: ReturnType<typeof makeShellThread>[] = [];
  let registrations = 0,
    sequence = 1;
  server.routes.route("POST /api/auth/websocket-ticket", () => ({
    status: 200,
    body: {
      ticket: server.issueTicket(),
      expiresAt: "2030-01-02T03:04:05.000Z",
    },
  }));
  server.routes.route("GET /api/orchestration/shell", () => ({
    status: 200,
    body: makeShellSnapshot({ projects, threads, snapshotSequence: sequence }),
  }));
  server.routes.route("PUT /api/mcp/provider-session", () => {
    registrations++;
    return { status: 204 };
  });
  server.routes.route("DELETE /api/mcp/provider-session", () => ({
    status: 204,
  }));
  server.handle("orchestration.getArchivedShellSnapshot", () => ({
    kind: "value",
    value: makeShellSnapshot({}),
  }));
  server.handle("orchestration.dispatchCommand", (payload) => {
    const command = payload as Record<string, unknown>;
    sequence++;
    if (command["type"] === "thread.create")
      threads.push(
        makeShellThread({
          id: command["threadId"],
          projectId: command["projectId"],
          title: command["title"],
          runtimeMode: command["runtimeMode"],
          worktreePath: command["worktreePath"],
        }),
      );
    return { kind: "value", value: { sequence } };
  });
  server.handle("orchestration.subscribeThread", (payload, context) => {
    const id = String((payload as Record<string, unknown>)["threadId"]);
    context.connection.send({
      _tag: "Chunk",
      requestId: context.requestId,
      values: [
        {
          kind: "snapshot",
          snapshot: makeSnapshot(
            makeThread({ id, projectId: projects[0]?.id }),
            sequence,
          ),
        },
        { kind: "synchronized" },
      ],
    });
    return { kind: "hang" };
  });
  const token = join(root, "token");
  writeFileSync(token, "fixture-token\n");
  const configPath = join(root, "config.yml");
  writeFileSync(
    configPath,
    `projects: []\ngithub:\n  credentialFile: /unused/app.yml\nblueprints:\n  repository: ${blueprints}\nt3Code:\n  endpoint: ${server.httpUrl}\n  tokenFile: ${token}\nstate:\n  databasePath: ${join(root, "state", "heddle.sqlite")}\npolling:\n  intervalMs: 30000\npass:\n  defaultModel:\n    instanceId: sample-provider\n    model: sample-model\n  defaultWorktree: ${root}\n`,
  );
  const config: ResolvedServiceConfig = {
    configPath,
    stateDirectory: join(root, "state"),
    databasePath: join(root, "state", "heddle.sqlite"),
    polling: { intervalMs: 30000 },
    projects: [],
    github: { credentialFile: "/unused/app.yml" },
    blueprints: { repository: blueprints },
    t3Code: { endpoint: server.httpUrl, tokenFile: token },
    state: {},
    pass: {
      defaultModel: { instanceId: "sample-provider", model: "sample-model" },
      defaultWorktree: root,
    },
  };
  const io = { output: () => undefined, error: () => undefined };
  try {
    const first = await startService(config, io);
    const paused = await first.engine?.start({
      id: "durable-run",
      blueprintId: "sample-process",
      commit: "fixture",
    });
    expect(paused?.status).toBe("awaiting");
    await vi.waitFor(() => {
      expect(registrations).toBe(1);
    });
    await first.close();
    const second = await startService(config, io);
    expect(second.engine?.store.get("durable-run").status).toBe("awaiting");
    await vi.waitFor(() => {
      expect(registrations).toBe(2);
    });
    await second.close();

    const packagedBefore = launch(configPath);
    const beforeOutput = await packagedStarted(packagedBefore);
    const beforePid = packagedBefore.pid;
    expect(beforeOutput).toContain("tools=http://127.0.0.1:");
    packagedBefore.kill("SIGKILL");
    await processExit(packagedBefore);

    const db = new DatabaseSync(config.databasePath);
    const row = db
      .prepare("SELECT data FROM pass_invocations WHERE run_id=?")
      .get("durable-run");
    const invocation = JSON.parse(String(row?.["data"])) as {
      binding: { path: string; token: string };
    };
    db.close();

    const packagedAfter = launch(configPath);
    const afterOutput = await packagedStarted(packagedAfter);
    const afterPid = packagedAfter.pid;
    const origin = /tools=(http:\/\/127\.0\.0\.1:\d+)/u.exec(afterOutput)?.[1];
    expect(origin).toBeDefined();
    const response = await fetch(String(origin) + invocation.binding.path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${invocation.binding.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "handoff", arguments: { accepted: true } },
      }),
    });
    expect(response.status).toBe(200);
    expect(beforePid).toBeTypeOf("number");
    packagedAfter.kill("SIGTERM");
    await processExit(packagedAfter);
    const verified = new DatabaseSync(config.databasePath, { readOnly: true });
    expect(
      verified
        .prepare("SELECT status FROM runs WHERE id=?")
        .get("durable-run")?.["status"],
    ).toBe("completed");
    verified.close();
    writeFileSync(
      "/tmp/task994-live-proof.json",
      JSON.stringify(
        {
          storePath: config.databasePath,
          runId: "durable-run",
          before: {
            pid: beforePid,
            state: "awaiting",
            command: `node dist/cli.js start --config ${configPath}`,
          },
          crash: `kill -9 ${String(beforePid)}`,
          after: {
            pid: afterPid,
            state: "completed",
            command: `node dist/cli.js start --config ${configPath}`,
          },
          advance: "generated handoff tool returned HTTP 200",
        },
        undefined,
        2,
      ) + "\n",
    );
  } finally {
    await server.close();
  }
}, 15_000);
