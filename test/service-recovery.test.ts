// ---
// relationships:
//   verifies: command-line-interface
// ---
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { GitHubBindingService } from "../src/binding/service.js";
import { createHmac } from "node:crypto";
import { createServer } from "node:net";
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
import { serviceHookSocket } from "../src/service/identity.js";
import { commitFixture, writeSample } from "./support/blueprint-repository.js";
import { freePort } from "./support/ports.js";
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

it("keeps the stable webhook route isolated across recovery, graceful restart, and SIGKILL while preserving pinned artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "service-recovery-"));
  roots.push(root);
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const address = reservation.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  const port = address.port;
  await new Promise<void>((resolve) =>
    reservation.close(() => {
      resolve();
    }),
  );
  const toolsPort = await freePort();
  const webhookOrigin = `http://127.0.0.1:${String(port)}`;
  const webhookUrl = `${webhookOrigin}/webhook/github`;
  const webhookSecret = join(root, "webhook-secret");
  writeFileSync(webhookSecret, "fixture-secret");
  const body = JSON.stringify({
    issue: { node_id: "sample-issue", updated_at: "2030-01-02T03:04:05Z" },
  });
  const signature = `sha256=${createHmac("sha256", "fixture-secret").update(body).digest("hex")}`;
  const deliver = (signed = true) =>
    fetch(webhookUrl, {
      method: "POST",
      headers: {
        "x-github-event": "issues",
        "x-hub-signature-256": signed ? signature : "invalid",
      },
      body,
    });
  const running: RunningService[] = [];
  const starting: Promise<RunningService>[] = [];
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
  let releaseRecovery = (): void => undefined;
  const recoveryGate = new Promise<void>((resolve) => {
    releaseRecovery = resolve;
  });
  server.routes.route("PUT /api/mcp/provider-session", async () => {
    registrations++;
    if (registrations === 2) await recoveryGate;
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
    `projects: []\nwebhook:\n  secretFile: ${webhookSecret}\n  listen: { host: 127.0.0.1, port: ${String(port)} }\ngithub:\n  credentialFile: /unused/app.yml\nblueprints:\n  repository: ${blueprints}\nt3Code:\n  endpoint: ${server.httpUrl}\n  tokenFile: ${token}\nstate:\n  databasePath: ${join(root, "state", "heddle.sqlite")}\npolling:\n  intervalMs: 30000\nagentTools:\n  listen: { host: 127.0.0.1, port: ${String(toolsPort)} }\npass:\n  defaultModel:\n    instanceId: sample-provider\n    model: sample-model\n  defaultWorktree: ${root}\n`,
  );
  const config: ResolvedServiceConfig = {
    configPath,
    stateDirectory: join(root, "state"),
    databasePath: join(root, "state", "heddle.sqlite"),
    polling: { intervalMs: 30000 },
    projects: [],
    webhook: { secretFile: webhookSecret, listen: { host: "127.0.0.1", port } },
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
  const discovered = vi.spyOn(GitHubBindingService.prototype, "discover");
  const io = { output: () => undefined, error: () => undefined };
  let active: RunningService | undefined;
  try {
    const first = (active = await startService(config, io));
    const beforeDelivery = discovered.mock.calls.length;
    expect((await deliver()).status).toBe(202);
    expect(discovered.mock.calls.length).toBeGreaterThan(beforeDelivery);
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
    const restarting = startService(config, io).then((service) => {
      running.push(service);
      return service;
    });
    starting.push(restarting);
    await vi.waitFor(() => {
      expect(registrations).toBe(2);
    });
    try {
      await expect(deliver()).rejects.toThrow();
    } finally {
      releaseRecovery();
    }
    const second = await restarting;
    expect((await deliver()).status).toBe(202);
    active = second;
    expect(second.engine?.store.get("durable-run").status).toBe("awaiting");
    await vi.waitFor(() => {
      expect(registrations).toBe(2);
    });
    await second.close();

    const packagedBefore = launch(configPath);
    const beforeOutput = await packagedStarted(packagedBefore);
    const beforePid = packagedBefore.pid;
    expect(beforeOutput).toContain(`webhook=${webhookUrl}`);
    expect(beforeOutput).not.toMatch(/tools=|fixture-secret|fixture-token/u);
    expect((await deliver()).status).toBe(202);
    expect(beforeOutput).toContain(
      `hooks=${serviceHookSocket(config.stateDirectory, config.databasePath)}`,
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
    const toolOrigin = () => {
      const registration = server.routes.requests
        .filter(
          (request) =>
            request.method === "PUT" &&
            request.path === "/api/mcp/provider-session",
        )
        .at(-1)?.body as { endpoint: string };
      return new URL(registration.endpoint).origin;
    };
    let origin = toolOrigin();
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
      const response = await fetch(origin + item.binding.path, {
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
    const invocation = readPass("durable-run", "inspect");
    if (!invocation.binding) throw new Error("Missing pass binding");
    expect(afterOutput).toContain(`webhook=${webhookUrl}`);
    expect(afterOutput).not.toMatch(/tools=|fixture-secret|fixture-token/u);
    expect((await deliver()).status).toBe(202);
    expect((await deliver(false)).status).toBe(500);
    expect(origin).not.toBe(webhookOrigin);
    for (const path of [
      invocation.binding.path,
      invocation.binding.path + "/policy",
      "/hook/stop",
      "/heddle.sqlite",
      "/hooks.sock",
      "/",
      "/webhook/github?extra=true",
    ]) {
      const denied = await fetch(webhookOrigin + path, {
        method: "POST",
        headers: { authorization: `Bearer ${invocation.binding.token}` },
        body: "{}",
      });
      expect(denied.status, path).toBe(404);
      expect(await denied.text()).toBe("");
    }
    expect((await fetch(webhookUrl)).status).toBe(404);
    expect(
      (await fetch(origin + "/webhook/github", { method: "POST" })).status,
    ).toBe(401);
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
    origin = toolOrigin();
    expect(newOutput).toContain(`webhook=${webhookUrl}`);
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
      join(root, "recovery-proof.json"),
      JSON.stringify(
        {
          webhookUrl,
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
    releaseRecovery();
    await Promise.allSettled(starting);
    for (const service of running) await service.close();
    await active?.close();
    await server.close();
    discovered.mockRestore();
  }
}, 15_000);
