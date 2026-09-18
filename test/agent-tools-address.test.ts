// ---
// relationships:
//   verifies: agent-tools
// ---
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import { commitFixture, writeSample } from "./support/blueprint-repository.js";
import { freePort } from "./support/ports.js";
import type { PassInvocation } from "../src/pass/types.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  const stopped = children.splice(0);
  for (const child of stopped)
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  await Promise.all(stopped.map(processExit));
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function launch(config: string): ChildProcess {
  const child = spawn(
    process.execPath,
    [
      process.env["HEDDLE_TEST_CLI"] ?? join(process.cwd(), "dist/cli.js"),
      "start",
      "--config",
      config,
      "--state",
      join(dirname(config), "state"),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  return child;
}
async function started(child: ChildProcess): Promise<string> {
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

it("serves a pre-restart generated tool URL after an abrupt and a graceful restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-tools-address-"));
  roots.push(root);
  const blueprints = join(root, "blueprints");
  mkdirSync(blueprints);
  writeSample(blueprints, "first");
  commitFixture(blueprints);
  const server = await FakeT3Server.start({ token: "fixture-token" });
  const projects = [makeShellProject({ workspaceRoot: root })];
  const threads: ReturnType<typeof makeShellThread>[] = [];
  let sequence = 1;
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
  server.routes.route("PUT /api/mcp/provider-session", () => ({ status: 204 }));
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
  const toolsPort = await freePort();
  const databasePath = join(root, "state", "heddle.sqlite");
  const configPath = join(root, "config.yml");
  writeFileSync(
    configPath,
    `projects: []\ngithub:\n  credentialFile: /unused/app.yml\nblueprints:\n  repository: ${blueprints}\nt3Code:\n  endpoint: ${server.httpUrl}\n  tokenFile: ${token}\nstate:\n  databasePath: ${databasePath}\npolling:\n  intervalMs: 30000\nagentTools:\n  listen: { host: 127.0.0.1, port: ${String(toolsPort)} }\npass:\n  defaultModel:\n    instanceId: sample-provider\n    model: sample-model\n  defaultWorktree: ${root}\n`,
  );
  const config: ResolvedServiceConfig = {
    configPath,
    stateDirectory: join(root, "state"),
    databasePath,
    polling: { intervalMs: 30000 },
    projects: [],
    github: { credentialFile: "/unused/app.yml" },
    blueprints: { repository: blueprints },
    t3Code: { endpoint: server.httpUrl, tokenFile: token },
    agentTools: { listen: { host: "127.0.0.1", port: toolsPort } },
    state: {},
    pass: {
      defaultModel: { instanceId: "sample-provider", model: "sample-model" },
      defaultWorktree: root,
    },
  };
  const io = { output: () => undefined, error: () => undefined };
  const readPass = (runId: string, nodeId: string): PassInvocation => {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = db
        .prepare(
          "SELECT data FROM pass_invocations WHERE run_id=? AND json_extract(data, '$.nodeId')=?",
        )
        .get(runId, nodeId);
      return JSON.parse(String(row?.["data"])) as PassInvocation;
    } finally {
      db.close();
    }
  };
  const call = (url: string, bearer: string, args: Record<string, boolean>) =>
    fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "handoff", arguments: args },
      }),
    });
  try {
    const seeded = await startService(config, io);
    const paused = await seeded.engine?.start({
      id: "durable-run",
      blueprintId: "sample-process",
      commit: "HEAD",
    });
    expect(paused?.status).toBe("awaiting");
    await seeded.close();

    const abrupt = launch(configPath);
    await started(abrupt);
    const first = readPass("durable-run", "inspect");
    if (!first.binding) throw new Error("Pass binding is missing");
    // The URL an already-registered provider session keeps across the restart.
    const registeredUrl = `http://127.0.0.1:${String(toolsPort)}${first.binding.path}`;
    const registeredToken = first.binding.token;
    abrupt.kill("SIGKILL");
    await processExit(abrupt);
    expect(abrupt.signalCode).toBe("SIGKILL");

    const revived = launch(configPath);
    await started(revived);
    const resumed = await call(registeredUrl, registeredToken, {
      accepted: true,
    });
    expect(resumed.status).toBe(200);
    expect(await resumed.text()).not.toContain('"isError":true');
    await vi.waitFor(() => {
      expect(readPass("durable-run", "measure").phase).toBe("active");
    });
    const second = readPass("durable-run", "measure");
    if (!second.binding) throw new Error("Pass binding is missing");
    const gracefulUrl = `http://127.0.0.1:${String(toolsPort)}${second.binding.path}`;
    revived.kill("SIGTERM");
    await processExit(revived);

    const restarted = launch(configPath);
    await started(restarted);
    const graceful = await call(gracefulUrl, second.binding.token, {
      first: true,
    });
    expect(graceful.status).toBe(200);
    expect(await graceful.text()).not.toContain('"isError":true');
    restarted.kill("SIGTERM");
    await processExit(restarted);
    const verified = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        verified
          .prepare("SELECT status FROM runs WHERE id=?")
          .get("durable-run")?.["status"],
      ).toBe("completed");
    } finally {
      verified.close();
    }
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    await Promise.all(children.map(processExit));
    await server.close();
  }
}, 20_000);
