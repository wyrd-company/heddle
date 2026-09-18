// ---
// relationships:
//   verifies: agent-tools
// ---
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import {
  exportHookPlugins,
  HookServer,
  HookSessions,
  GeneratedToolService,
  prepareAgentTools,
  RunStore,
  WorkflowEngine,
  type SessionBinding,
  type ToolBinding,
} from "../src/index.js";
import { runStopHook } from "../src/agent-tools/hooks.js";
import pluginContracts from "../src/agent-tools/plugin-contracts.json" with { type: "json" };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
    server.closeAllConnections();
  });
}
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "heddle-hooks-"));
  cleanups.push(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const path = join(directory, "runs.sqlite");
  const store = new RunStore(path);
  cleanups.push(() => {
    store.close();
  });
  const bindings = new Map<string, ToolBinding>();
  const engine = new WorkflowEngine(store, {
    resolveBlueprint: () =>
      Promise.resolve({
        id: "inspect",
        nodes: [{ id: "inspect", uses: "pass" }],
        edges: [],
      }),
    nodes: {
      pass: async (context) => {
        const prepared = prepareAgentTools({
          threadId: "thread-" + context.run.id,
          handoff: { type: "object", description: "Submit the inspection." },
          context: context.context,
        });
        bindings.set(context.run.id, prepared.binding);
        await context.await(prepared.details);
      },
    },
  });
  const sessions = new HookSessions(store);
  const mapped: SessionBinding[] = [];
  for (const id of ["first", "second"]) {
    await engine.start({ id, blueprintId: "inspect", commit: "snapshot-a" });
    const item = required(store.awaiting(id)[0]);
    const binding = required(bindings.get(id));
    sessions.register(item, binding);
    const mapping = {
      ...binding,
      runId: id,
      nodeId: item.nodeId,
      visit: item.visit,
      threadId: required(item.details.threadId),
    };
    sessions.observe(mapping, "native-" + id);
    mapped.push(mapping);
  }
  const tools = new GeneratedToolService(engine);
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    void tools.handle(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => close(server));
  const origin = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
  const hooks = new HookServer(sessions, origin);
  const received: string[] = [];
  const local = createServer((req, res) => {
    req.on("data", (data: Buffer) => received.push(String(data)));
    void hooks.handle(req, res);
  });
  const socket = join(directory, "hooks.sock");
  local.listen(socket);
  await once(local, "listening");
  cleanups.push(() => close(local));
  const state = () =>
    ["runs", "awaiting", "events", "hook_sessions"].map((table) =>
      store.db.prepare(`SELECT * FROM ${table}`).all(),
    );
  return {
    directory,
    path,
    engine,
    store,
    bindings,
    mapped,
    sessions,
    tools,
    hooks,
    requests,
    received,
    socket,
    state,
  };
}

it.each(["claude", "codex"] as const)(
  "exported %s plugin invokes the actual CLI with unchanged session_id",
  async (harness) => {
    const f = await fixture();
    const packages = join(f.directory, "packages");
    await exportHookPlugins(packages);
    for (const path of pluginContracts[harness])
      expect(statSync(join(packages, harness, path)).isFile()).toBe(true);
    const hookFile = join(packages, harness, "plugins/heddle/hooks/hooks.json");
    const original = readFileSync(hookFile, "utf8");
    await exportHookPlugins(packages);
    expect(readFileSync(hookFile, "utf8")).toBe(original);
    const definition = JSON.parse(original) as {
      hooks: { Stop: { hooks: { command: string }[] }[] };
    };
    expect(definition.hooks.Stop).toHaveLength(1);
    expect(required(definition.hooks.Stop[0]).hooks).toHaveLength(1);
    const command = required(
      required(definition.hooks.Stop[0]).hooks[0],
    ).command;
    expect(command).toBe(`heddle hook stop ${harness}`);
    const input = {
      hook_event_name: "Stop",
      session_id: "native-first",
      stop_hook_active: false,
      cwd: "/unrelated",
      threadId: "thread-second",
      path: required(f.mapped[1]).path,
      token: required(f.mapped[1]).token,
    };
    const child = spawn(
      process.execPath,
      [join(process.cwd(), "dist/cli.js"), ...command.split(" ").slice(1)],
      { env: { ...process.env, HEDDLE_STATE_DIR: f.directory } },
    );
    let out = "";
    child.stdout.on("data", (data) => {
      out += String(data);
    });
    child.stdin.end(JSON.stringify(input));
    const [code] = (await once(child, "close")) as unknown[];
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({
      decision: "block",
      reason: "Call the handoff tool for this stage before ending the turn.",
    });
    expect(f.received).toEqual([
      JSON.stringify({ session_id: "native-first" }),
    ]);
    expect(f.requests).toEqual([required(f.mapped[0]).path + "/policy"]);
  },
);

it("allows an ordinary session beside active sessions without endpoint calls or state change", async () => {
  const f = await fixture();
  const before = f.state();
  expect(
    await runStopHook(
      "codex",
      JSON.stringify({ hook_event_name: "Stop", session_id: "ordinary" }),
      f.socket,
    ),
  ).toEqual({});
  expect(f.requests).toEqual([]);
  expect(f.state()).toEqual(before);
  expect(await f.hooks.decide("native-first")).toMatchObject({
    decision: "block",
  });
  f.tools.setPolicy(required(f.mapped[1]).path, "allow", "fixture-operator");
  expect(await f.hooks.decide("native-second")).toEqual({});
  expect(f.requests).toEqual(
    f.mapped.map((binding) => binding.path + "/policy"),
  );
});

it("does not guess an ambiguous identity or disturb unrelated sessions", async () => {
  const f = await fixture();
  f.sessions.observe(required(f.mapped[1]), "native-first");
  const before = f.state();
  await expect(f.hooks.decide("native-first")).rejects.toThrow(
    "Ambiguous native session identity",
  );
  expect(await f.hooks.decide("ordinary")).toEqual({});
  expect(f.requests).toEqual([]);
  expect(f.state()).toEqual(before);
});

it("rejects registration for a thread already owned by a different active pass", async () => {
  const f = await fixture();
  const item = required(f.store.awaiting("second")[0]);
  item.details.threadId = "thread-first";
  f.store.db
    .prepare("UPDATE awaiting SET thread_id=?,details=? WHERE run_id='second'")
    .run(item.details.threadId, JSON.stringify(item.details));
  expect(() => {
    f.sessions.register(item, required(f.bindings.get("second")));
  }).toThrow("already belongs to an active pass");
});

it("rejects registration with a binding outside the durable awaiting occurrence", async () => {
  const f = await fixture();
  const item = required(f.store.awaiting("first")[0]);
  expect(() => {
    f.sessions.register(
      { ...item, visit: 2 },
      required(f.bindings.get("first")),
    );
  }).toThrow("inactive pass binding");
  expect(() => {
    f.sessions.register(item, {
      ...required(f.bindings.get("first")),
      token: "wrong",
    });
  }).toThrow("inactive pass binding");
});

it("replaces native identities and ignores retired occurrence updates", async () => {
  const f = await fixture();
  f.sessions.observe(required(f.mapped[0]), null);
  expect(await f.hooks.decide("native-first")).toEqual({});
  f.sessions.observe(required(f.mapped[0]), "native-replacement");
  expect(await f.hooks.decide("native-replacement")).toMatchObject({
    decision: "block",
  });
  await f.engine.resume({
    runId: "first",
    nodeId: "inspect",
    visit: 1,
    result: "handoff",
  });
  f.sessions.observe(required(f.mapped[0]), "retired-update");
  expect(
    f.store.db
      .prepare("SELECT session_id FROM hook_sessions WHERE run_id='first'")
      .get()?.["session_id"],
  ).toBe("native-replacement");
  const before = f.state();
  const calls = f.requests.length;
  expect(await f.hooks.decide("native-replacement")).toEqual({});
  expect(await f.hooks.decide("retired-update")).toEqual({});
  expect(f.state()).toEqual(before);
  expect(f.requests).toHaveLength(calls);
  expect(f.sessions.resolve("native-second")?.path).toBe(
    required(f.mapped[1]).path,
  );
  const recovered = new HookSessions(f.store);
  recovered.reconcile();
  expect(f.store.db.prepare("SELECT run_id FROM hook_sessions").all()).toEqual([
    { run_id: "second" },
  ]);
  expect(recovered.resolve("native-replacement")).toBeUndefined();
  expect(recovered.resolve("native-second")?.path).toBe(
    required(f.mapped[1]).path,
  );
});

it("rejects altered endpoint/token/visit/thread agreements", async () => {
  const f = await fixture();
  const binding = required(f.mapped[0]);
  for (const patch of [
    { path: "/agent-tools/other" },
    { token: "other" },
    { visit: 2 },
    { threadId: "other" },
  ]) {
    f.sessions.observe({ ...binding, ...patch }, "forged");
    expect(f.sessions.resolve("forged")).toBeUndefined();
  }
  f.store.db
    .prepare("UPDATE hook_sessions SET token='other' WHERE run_id='first'")
    .run();
  expect(await f.hooks.decide("native-first")).toEqual({});
  expect(f.requests).toEqual([]);
});

it.each([
  ["visit", 2],
  ["thread_id", "unrelated-thread"],
  ["path", "/agent-tools/unrelated"],
  ["token", "unrelated-token"],
] as const)(
  "does not resolve a persisted mapping with a mismatched %s",
  async (column, value) => {
    const f = await fixture();
    f.store.db
      .prepare(`UPDATE hook_sessions SET ${column}=? WHERE run_id='first'`)
      .run(value);
    const before = f.state();
    expect(await f.hooks.decide("native-first")).toEqual({});
    expect(f.requests).toEqual([]);
    expect(f.state()).toEqual(before);
  },
);

it.each(["failed", "completed"])(
  "does not route an ended %s pass even if its awaiting row remains",
  async (status) => {
    const f = await fixture();
    f.store.db.prepare("UPDATE runs SET status=? WHERE id='first'").run(status);
    expect(await f.hooks.decide("native-first")).toEqual({});
    expect(f.requests).toEqual([]);
  },
);

it("does not route a revoked instance", async () => {
  const f = await fixture();
  f.tools.revoke(required(f.mapped[0]).path);
  expect(await f.hooks.decide("native-first")).toEqual({});
  expect(f.requests).toEqual([]);
});

it("does not keep blocking after handoff retires an in-flight policy request", async () => {
  const f = await fixture();
  const server = createServer((_req, res) => {
    void f.engine
      .resume({
        runId: "first",
        nodeId: "inspect",
        visit: 1,
        result: "handoff",
      })
      .then(() => {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            policy: "require-handoff",
            requirement: "Submit the inspection.",
          }),
        );
      });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => close(server));
  const hooks = new HookServer(
    f.sessions,
    `http://127.0.0.1:${String((server.address() as { port: number }).port)}`,
  );
  expect(await hooks.decide("native-first")).toEqual({});
  expect(
    f.store.events("first").filter((event) => event.type === "resume"),
  ).toHaveLength(1);
});

it("allows when Heddle has no local runtime and rejects malformed hook input", async () => {
  const f = await fixture();
  expect(
    await runStopHook(
      "claude",
      JSON.stringify({ hook_event_name: "Stop", session_id: "ordinary" }),
      join(f.directory, "absent.sock"),
    ),
  ).toEqual({});
  await expect(
    runStopHook(
      "claude",
      JSON.stringify({ hook_event_name: "Other", session_id: "ordinary" }),
      f.socket,
    ),
  ).rejects.toThrow("Invalid Stop hook input");
});

it("keeps hook bindings out of ordinary and linked worktrees and Git metadata", async () => {
  const f = await fixture();
  const ordinary = join(f.directory, "ordinary");
  const linked = join(f.directory, "linked");
  execFileSync("git", ["init", "--quiet", ordinary]);
  execFileSync("git", [
    "-C",
    ordinary,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  execFileSync("git", [
    "-C",
    ordinary,
    "worktree",
    "add",
    "--quiet",
    "--detach",
    linked,
  ]);
  const files = (directory: string): Record<string, string> =>
    Object.fromEntries(
      readdirSync(directory, { recursive: true })
        .filter((name): name is string => typeof name === "string")
        .map((name) => join(directory, name))
        .filter((name) => statSync(name).isFile())
        .map((name) => [name, readFileSync(name).toString("base64")]),
    );
  const before = { ...files(ordinary), ...files(linked) };
  for (const cwd of [ordinary, linked]) {
    expect(
      await runStopHook(
        "claude",
        JSON.stringify({
          hook_event_name: "Stop",
          session_id: "native-first",
          cwd,
        }),
        f.socket,
      ),
    ).toMatchObject({ decision: "block" });
  }
  await f.engine.resume({
    runId: "first",
    nodeId: "inspect",
    visit: 1,
    result: "handoff",
  });
  f.sessions.reconcile();
  expect({ ...files(ordinary), ...files(linked) }).toEqual(before);
  expect(
    f.store.db
      .prepare("SELECT token FROM hook_sessions WHERE run_id='first'")
      .get(),
  ).toBeUndefined();
});

it("retains configured validation dispatch beside Stop hook commands", async () => {
  const directory = mkdtempSync(join(tmpdir(), "heddle-cli-"));
  cleanups.push(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const config = join(directory, "invalid.yml");
  writeFileSync(config, "projects: invalid\n");
  const child = spawn(
    process.execPath,
    [
      join(process.cwd(), "dist/cli.js"),
      "validate",
      "--check-requires-issue",
      "fixtures/blueprints/recipe-pipeline/recipe-pipeline.yml",
    ],
    { env: { ...process.env, HEDDLE_CONFIG: config } },
  );
  let error = "";
  child.stderr.on("data", (data) => (error += String(data)));
  const [code] = (await once(child, "close")) as unknown[];
  expect(code).toBe(1);
  expect(error).toContain("projects");
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
