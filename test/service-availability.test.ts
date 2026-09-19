// ---
// relationships:
//   verifies: command-line-interface
// ---
import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  statSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowEngine } from "../src/engine/engine.js";
import { RunStore } from "../src/engine/store.js";
import { PassService } from "../src/pass/service.js";
import { GitHubBindingService } from "../src/binding/service.js";
import { prepareAgentTools } from "../src/agent-tools/index.js";
import { runStopHook, hookSocketPath } from "../src/agent-tools/hooks.js";
import { startService, type RunningService } from "../src/service/service.js";
import { serviceHookSocket } from "../src/service/identity.js";
import type { ResolvedServiceConfig } from "../src/service/config.js";

import { commitFixture, fixtureGit } from "./support/blueprint-repository.js";
import { freePort } from "./support/ports.js";

const roots: string[] = [];
const services: RunningService[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const service of services.splice(0).reverse()) await service.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function fixture(): Promise<ResolvedServiceConfig> {
  const root = mkdtempSync(join(tmpdir(), "availability-"));
  roots.push(root);
  const repository = join(root, "blueprints");
  mkdirSync(repository);
  writeFileSync(
    join(repository, "sample-process.yml"),
    `id: sample-process
kind: process
nodes:
  inspect:
    uses: pass
    params:
      prompt: { inline: Inspect the sample. }
      handoff: { type: object, description: Submit the result., properties: { accepted: { type: boolean } } }
  finish:
    uses: terminal-result
    params: { value: done }
edges:
  - { from: inspect, to: finish, when: result.output.handoff }
  - { from: inspect, to: finish, when: result.output.escalate }
  - { from: inspect, to: finish, when: result.output.timeout }
  - { from: inspect, to: finish, when: result.output.idle }
  - { from: inspect, to: finish, when: result.output.turnEnded }
  - { from: inspect, to: finish, when: result.output.overridden }
`,
  );
  commitFixture(repository);
  const secretFile = join(root, "webhook-secret");
  writeFileSync(secretFile, "fixture-secret");
  return {
    configPath: join(root, "config.yml"),
    stateDirectory: root,
    databasePath: join(root, "heddle.sqlite"),
    state: {},
    projects: [],
    polling: { intervalMs: 30000 },
    github: { credentialFile: "/unused/app.yml" },
    blueprints: { repository },
    t3Code: { endpoint: "http://127.0.0.1:3000" },
    webhook: { secretFile },
    agentTools: { listen: { host: "127.0.0.1", port: await freePort() } },
    pass: {
      defaultModel: { instanceId: "sample-provider", model: "sample-model" },
      defaultWorktree: root,
    },
  };
}
const io = { output: () => undefined, error: () => undefined };
function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

it("gates valid mutating webhook and tool requests throughout engine and pass recovery", async () => {
  const config = await fixture();
  const reserved = createServer();
  await new Promise<void>((resolve) => {
    reserved.listen(0, "127.0.0.1", resolve);
  });
  const reservedAddress = reserved.address();
  if (!reservedAddress || typeof reservedAddress === "string")
    throw new Error("Missing reserved port");
  const port = reservedAddress.port;
  await new Promise<void>((resolve) => {
    reserved.close(() => {
      resolve();
    });
  });
  if (!config.webhook) throw new Error("Missing webhook fixture");
  config.webhook.listen = { host: "127.0.0.1", port };
  const webhookOrigin = `http://127.0.0.1:${String(port)}`;
  const seeded = new RunStore(config.databasePath);
  const prepared = prepareAgentTools({
    threadId: "sample-thread",
    handoff: { type: "object", description: "Submit the result." },
    context: {},
  });
  const seed = new WorkflowEngine(seeded, {
    resolveBlueprint: () =>
      Promise.resolve({
        id: "sample-process",
        nodes: [{ id: "inspect", uses: "pass" }],
        edges: [],
      }),
    nodes: {
      pass: async (context) => {
        await context.await(prepared.details);
      },
    },
  });
  await seed.start({
    id: "sample-run",
    blueprintId: "sample-process",
    commit: fixtureGit(config.blueprints.repository, "rev-parse", "HEAD"),
  });
  seeded.db.exec("CREATE TABLE request_effects (kind TEXT NOT NULL)");
  seeded.close();
  const engineGate = barrier(),
    engineEntered = barrier(),
    passGate = barrier(),
    passEntered = barrier();
  // Preserve the original method for an explicit call with the captured receiver.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const recoverEngine = WorkflowEngine.prototype.recover;
  let store!: RunStore;
  vi.spyOn(WorkflowEngine.prototype, "recover").mockImplementation(
    async function (this: WorkflowEngine) {
      store = this.store;
      engineEntered.release();
      await engineGate.wait;
      await recoverEngine.call(this);
    },
  );
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const recoverPass = PassService.prototype.recover;
  vi.spyOn(PassService.prototype, "recover").mockImplementation(async function (
    this: PassService,
  ) {
    passEntered.release();
    await passGate.wait;
    await recoverPass.call(this);
  });
  // Discovery is the outbound GitHub boundary. Keep HTTP routing, signature
  // validation, delivery dispatch, and the service's real SQLite writer intact.
  vi.spyOn(GitHubBindingService.prototype, "discover").mockImplementation(
    function (this: GitHubBindingService) {
      this.store.db.exec("INSERT INTO request_effects VALUES ('discovery')");
      return Promise.resolve();
    },
  );
  const toolListen = config.agentTools?.listen;
  if (!toolListen) throw new Error("Fixture needs an agent-tools address");
  const origin = `http://${toolListen.host}:${String(toolListen.port)}`;
  const body = JSON.stringify({
    issue: { node_id: "sample-issue", updated_at: "2030-01-02T03:04:05Z" },
  });
  const webhook = () =>
    fetch(`${webhookOrigin}/webhook/github`, {
      method: "POST",
      headers: {
        "x-github-event": "issues",
        "x-hub-signature-256": `sha256=${createHmac("sha256", "fixture-secret").update(body).digest("hex")}`,
      },
      body,
    });
  const handoff = () =>
    fetch(origin + prepared.binding.path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${prepared.binding.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "handoff", arguments: {} },
      }),
    });
  const starting = startService(config, io);
  try {
    await Promise.race([engineEntered.wait, starting]);
    for (const phase of ["engine", "pass"]) {
      if (phase === "pass") {
        engineGate.release();
        await passEntered.wait;
      }
      expect(
        existsSync(
          serviceHookSocket(config.stateDirectory, config.databasePath),
        ),
        phase,
      ).toBe(false);
      const changes = store.db.prepare("SELECT total_changes() AS count").get();
      await expect(webhook(), phase).rejects.toThrow();
      expect((await handoff()).status, phase).toBe(503);
      expect(
        store.db.prepare("SELECT total_changes() AS count").get(),
        phase,
      ).toEqual(changes);
      expect(store.get("sample-run").status, phase).toBe("awaiting");
    }
    passGate.release();
    const service = await starting;
    services.push(service);
    const before = Number(
      store.db.prepare("SELECT count(*) AS count FROM request_effects").get()?.[
        "count"
      ],
    );
    expect((await webhook()).status).toBe(202);
    expect(
      Number(
        store.db
          .prepare("SELECT count(*) AS count FROM request_effects")
          .get()?.["count"],
      ),
    ).toBe(before + 1);
    expect((await handoff()).status).toBe(200);
    expect(store.get("sample-run").status).toBe("completed");
  } finally {
    engineGate.release();
    passGate.release();
    const service = await starting;
    if (!services.includes(service)) services.push(service);
  }
});

it("keeps different databases' hook endpoints live and independent in one state directory", async () => {
  const firstConfig = await fixture();
  const first = await startService(firstConfig, io);
  services.push(first);
  const firstSocket = serviceHookSocket(
    firstConfig.stateDirectory,
    firstConfig.databasePath,
  );
  const before = statSync(firstSocket);
  const secondConfig = {
    ...firstConfig,
    databasePath: join(firstConfig.stateDirectory, "other.sqlite"),
    agentTools: { listen: { host: "127.0.0.1", port: await freePort() } },
  };
  const second = await startService(secondConfig, io);
  services.push(second);
  const secondSocket = serviceHookSocket(
    secondConfig.stateDirectory,
    secondConfig.databasePath,
  );
  expect(secondSocket).not.toBe(firstSocket);
  expect(statSync(firstSocket).ino).toBe(before.ino);
  const input = JSON.stringify({
    hook_event_name: "Stop",
    session_id: "sample-session",
  });
  expect(await runStopHook("codex", input, firstSocket)).toEqual({});
  expect(await runStopHook("codex", input, secondSocket)).toEqual({});
  await second.close();
  expect(statSync(firstSocket).ino).toBe(before.ino);
  expect(await runStopHook("codex", input, firstSocket)).toEqual({});
  vi.stubEnv("HEDDLE_STATE_DIR", firstConfig.stateDirectory);
  vi.stubEnv("HEDDLE_HOOK_SOCKET", "");
  expect(hookSocketPath()).toBe(firstSocket);
  vi.stubEnv("HEDDLE_HOOK_SOCKET", secondSocket);
  expect(hookSocketPath()).toBe(secondSocket);
});

it.each(["existing", "missing"] as const)(
  "uses the database identity across state overrides and symlink aliases when target is %s",
  async (target) => {
    const config = await fixture();
    const alias = join(config.stateDirectory, "alias.sqlite");
    if (target === "missing") symlinkSync(basename(config.databasePath), alias);
    const first = await startService(
      {
        ...config,
        databasePath: target === "missing" ? alias : config.databasePath,
      },
      io,
    );
    services.push(first);
    if (target === "existing") symlinkSync(config.databasePath, alias);
    expect(
      existsSync(serviceHookSocket(config.stateDirectory, config.databasePath)),
    ).toBe(true);
    await expect(
      startService(
        {
          ...config,
          stateDirectory: join(config.stateDirectory, "other"),
          databasePath: alias,
        },
        io,
      ).then((service) => {
        services.push(service);
        return service;
      }),
    ).rejects.toThrow("already owned");
  },
);

it("keeps the default hook inert before its state directory exists", async () => {
  const config = await fixture();
  vi.stubEnv("HEDDLE_STATE_DIR", join(config.stateDirectory, "absent"));
  vi.stubEnv("HEDDLE_HOOK_SOCKET", "");
  expect(
    await runStopHook(
      "codex",
      JSON.stringify({ hook_event_name: "Stop", session_id: "sample-session" }),
    ),
  ).toEqual({});
});

it("serves hooks under a deep state directory with a compact database identity", async () => {
  const config = await fixture();
  const stateDirectory = join(
    config.stateDirectory,
    "s".repeat(83 - config.stateDirectory.length - 1),
  );
  mkdirSync(stateDirectory);
  const service = await startService({ ...config, stateDirectory }, io);
  services.push(service);
  const socket = serviceHookSocket(stateDirectory, config.databasePath);
  expect(Buffer.byteLength(socket)).toBe(100);
  expect(statSync(socket).isSocket()).toBe(true);
  vi.stubEnv("HEDDLE_HOOK_SOCKET", socket);
  expect(
    await runStopHook(
      "codex",
      JSON.stringify({ hook_event_name: "Stop", session_id: "sample-session" }),
    ),
  ).toEqual({});
});

it("fails startup when the configured agent-tools address is already bound", async () => {
  const config = await fixture();
  const listen = config.agentTools?.listen;
  if (!listen) throw new Error("Fixture needs an agent-tools address");
  const blocker = createServer();
  await new Promise<void>((resolve) => {
    blocker.listen(listen.port, listen.host, resolve);
  });
  try {
    await expect(startService(config, io)).rejects.toThrow(
      `${listen.host}:${String(listen.port)}`,
    );
  } finally {
    await new Promise<void>((resolve) => {
      blocker.close(() => {
        resolve();
      });
    });
  }
});
