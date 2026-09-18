// ---
// relationships:
//   verifies: command-line-interface
// ---
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import type { PassInvocation } from "../src/pass/types.js";
import type { RunningService } from "../src/service/service.js";

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
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        XDG_STATE_HOME: join(dirname(config), "alternate-state"),
      },
    },
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

it("recovers pinned graph prompt schema and policy after packaged process death and repository change", async () => {
  const root = mkdtempSync(join(tmpdir(), "service-recovery-"));
  roots.push(root);
  const blueprints = join(root, "blueprints");
  mkdirSync(blueprints);
  writeSample(blueprints, "first");
  const firstCommit = commitFixture(blueprints);
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
  let active: RunningService | undefined;
  try {
    const first = (active = await startService(config, io));
    const paused = await first.engine?.start({
      id: "durable-run",
      blueprintId: "sample-process",
      commit: "HEAD",
    });
    expect(paused?.status).toBe("awaiting");
    expect(paused?.commit).toBe(firstCommit);
    await vi.waitFor(() => {
      expect(registrations).toBe(1);
    });
    await first.close();
    const second = (active = await startService(config, io));
    expect(second.engine?.store.get("durable-run").status).toBe("awaiting");
    await vi.waitFor(() => {
      expect(registrations).toBe(2);
    });
    await second.close();

    const packagedBefore = launch(configPath);
    const beforeOutput = await packagedStarted(packagedBefore);
    const beforePid = packagedBefore.pid;
    expect(beforeOutput).toContain("tools=http://127.0.0.1:");
    expect(beforeOutput).toContain(
      `hooks=${join(root, "state", "hooks.sock")}`,
    );
    writeSample(blueprints, "second");
    const secondCommit = commitFixture(blueprints);
    writeSample(blueprints, "uncommitted");
    packagedBefore.kill("SIGKILL");
    await processExit(packagedBefore);
    expect(packagedBefore.signalCode).toBe("SIGKILL");

    const packagedAfter = launch(configPath);
    const afterOutput = await packagedStarted(packagedAfter);
    const afterPid = packagedAfter.pid;
    let origin = /tools=(http:\/\/127\.0\.0\.1:\d+)/u.exec(afterOutput)?.[1];
    expect(origin).toBeDefined();
    const readPass = (runId: string, nodeId: string): PassInvocation => {
      const db = new DatabaseSync(config.databasePath, { readOnly: true });
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
    const handoff = async (
      runId: string,
      nodeId: string,
      arguments_: Record<string, boolean>,
    ) => {
      const item = readPass(runId, nodeId);
      expect(item.binding).not.toBeNull();
      if (!item.binding) throw new Error("Pass binding is missing");
      const response = await fetch(String(origin) + item.binding.path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${item.binding.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "handoff", arguments: arguments_ },
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).not.toContain('"isError":true');
    };
    await handoff("durable-run", "inspect", { accepted: true });
    await vi.waitFor(() => {
      expect(readPass("durable-run", "measure").phase).toBe("active");
    });
    const pinnedPass = readPass("durable-run", "measure");
    expect(pinnedPass.prompt).toBe("Inspect the first parcel.\r\n");
    expect(pinnedPass.details["agentTools"]).toMatchObject({
      handoff: { required: ["first"] },
    });
    await handoff("durable-run", "measure", { first: true });
    expect(beforePid).toBeTypeOf("number");
    packagedAfter.kill("SIGTERM");
    await processExit(packagedAfter);
    const verified = new DatabaseSync(config.databasePath, { readOnly: true });
    expect(
      verified
        .prepare("SELECT status FROM runs WHERE id=?")
        .get("durable-run")?.["status"],
    ).toBe("completed");
    const pinnedRow = verified
      .prepare("SELECT blueprint_commit, context FROM runs WHERE id=?")
      .get("durable-run");
    const pinnedContext = JSON.parse(String(pinnedRow?.["context"])) as Record<
      string,
      unknown
    >;
    expect(pinnedRow?.["blueprint_commit"]).toBe(firstCommit);
    expect(pinnedContext["result"]).toBe("first-graph");
    expect(pinnedContext["_outputs.choose"]).toMatchObject({ id: "first" });
    verified.close();

    const latest = (active = await startService(config, io));
    const newRun = await latest.engine?.start({
      id: "new-run",
      blueprintId: "sample-process",
      commit: "HEAD",
    });
    expect(newRun?.commit).toBe(secondCommit);
    await latest.close();
    const packagedNew = launch(configPath);
    const newOutput = await packagedStarted(packagedNew);
    origin = /tools=(http:\/\/127\.0\.0\.1:\d+)/u.exec(newOutput)?.[1];
    await handoff("new-run", "inspect", { accepted: true });
    await vi.waitFor(() => {
      expect(readPass("new-run", "measure").phase).toBe("active");
    });
    expect(readPass("new-run", "measure").prompt).toBe(
      "Inspect the second parcel.\r\n",
    );
    expect(readPass("new-run", "measure").details["agentTools"]).toMatchObject({
      handoff: { required: ["second"] },
    });
    await handoff("new-run", "measure", { second: true });
    packagedNew.kill("SIGTERM");
    await processExit(packagedNew);
    const newer = new DatabaseSync(config.databasePath, { readOnly: true });
    try {
      const row = newer
        .prepare("SELECT status, context FROM runs WHERE id=?")
        .get("new-run");
      expect(row?.["status"]).toBe("completed");
      const context = JSON.parse(String(row?.["context"])) as Record<
        string,
        unknown
      >;
      expect(context["result"]).toBe("second-graph");
      expect(context["_outputs.choose"]).toMatchObject({ id: "second" });
    } finally {
      newer.close();
    }
    writeFileSync(
      "/tmp/task997-live-proof.json",
      JSON.stringify(
        {
          firstCommit,
          secondCommit,
          liveContent: "uncommitted",
          pinnedPrompt: pinnedPass.prompt,
          pinnedSchema: "first",
          pinnedPolicy: "first",
          pinnedGraph: "first-graph",
          newContent: "second",
          storePath: config.databasePath,
          runId: "durable-run",
          before: {
            pid: beforePid,
            state: "awaiting",
            command: packagedBefore.spawnargs,
          },
          crash: `kill -9 ${String(beforePid)}`,
          after: {
            pid: afterPid,
            state: "completed",
            command: packagedAfter.spawnargs,
          },
          advance: "generated handoff tool returned HTTP 200",
        },
        undefined,
        2,
      ) + "\n",
    );
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    await Promise.all(children.map(processExit));
    await active?.close();
    await server.close();
  }
}, 15_000);
