// ---
// relationships:
//   verifies:
//     - node-types
//     - agent-tools
// ---
import { readFileSync, appendFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import {
  RunStore,
  WorkflowEngine,
  PassService,
  HookServer,
} from "../src/index.js";
import { T3Client } from "../src/t3code/index.js";
import type { WorkflowBlueprint } from "flowcraft";
const config = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const log = (kind: string, data: unknown = {}) =>
  appendFileSync(
    join(config.state, "ordering.jsonl"),
    JSON.stringify({ at: Date.now(), kind, data }) + "\n",
  );
const client = T3Client.create({
  baseUrl: config.t3Url,
  accessToken: readFileSync(config.tokenFile, "utf8").trim(),
});
const store = new RunStore(join(config.state, "runs.sqlite"));
let passes: PassService;
const blueprint = config.blueprint as WorkflowBlueprint;
const engine = new WorkflowEngine(store, {
  resolveBlueprint: () => Promise.resolve(blueprint),
  nodes: { pass: (context) => passes.node(context), finish: async () => null },
  onBoundary: async (run) => {
    log("boundary", {
      status: run.status,
      awaiting: store
        .awaiting(run.id)
        .map((row) => ({ nodeId: row.nodeId, visit: row.visit })),
    });
    if (config.holdAfterHandoff && run.status === "resuming") {
      process.send?.({ kind: "handoff-committed" });
      await new Promise(() => {});
    }
    await passes.synchronize(run);
    log("reconciled", {
      status: run.status,
      mappings: store.db
        .prepare("SELECT COUNT(*) AS count FROM hook_sessions")
        .get()?.["count"],
    });
    if (run.status === "completed" || run.status === "failed")
      process.send?.({ kind: "terminal", status: run.status });
  },
});
passes = new PassService(engine, {
  client,
  toolOrigin: `http://127.0.0.1:${config.port}`,
  defaultModel: config.model,
  defaultWorktree: config.workspace,
  readArtifact: async () => {
    throw new Error("live fixture uses inline artifacts");
  },
});
const tools = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += String(chunk);
  });
  request.on("end", () => {
    try {
      const input = JSON.parse(body);
      if (input.method === "tools/call")
        log("tool-call", { name: input.params?.name });
    } catch {
      /* Policy GET has no body. */
    }
  });
  if (request.url?.endsWith("/policy")) log("policy-request");
  response.once("finish", () => {
    log("tool-response", {
      status: response.statusCode,
      path: request.url?.endsWith("/policy") ? "policy" : "mcp",
    });
  });
  void passes.tools.handle(request, response).catch((error) => {
    log("tool-error", { message: String(error) });
    response.destroy();
  });
});
const hooks = new HookServer(
  passes.sessions,
  `http://127.0.0.1:${config.port}`,
);
const socket = join(config.profile, "hooks.sock");
rmSync(socket, { force: true });
const hookServer = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += String(chunk);
  });
  request.on("end", () => {
    log("native-stop", JSON.parse(body));
  });
  response.once("finish", () => {
    log("hook-response", { status: response.statusCode });
  });
  void hooks.handle(request, response);
});
await passes.recover();
tools.listen(config.port, "127.0.0.1");
await once(tools, "listening");
hookServer.listen(socket);
await once(hookServer, "listening");
await engine.recover();
process.send?.({ kind: "ready" });
process.on("message", (message) => {
  void (async () => {
    if (message === "start") {
      const run = await engine.start({
        id: "fixture",
        blueprintId: blueprint.id,
        commit: "fixture-pinned",
        context: { item: "parcel" },
      });
      process.send?.({ kind: "started", status: run.status });
    }
    if (message === "state")
      process.send?.({
        kind: "state",
        runs: store
          .list()
          .map((run) => ({
            id: run.id,
            status: run.status,
            context: run.context,
          })),
        events: store
          .list()
          .flatMap((run) =>
            store
              .events(run.id)
              .map((event) => ({
                type: event.type,
                payload: event.type === "pause" ? undefined : event.payload,
              })),
          ),
        views: store
          .awaiting()
          .map((row) => passes.read(row.runId, row.nodeId, row.visit)),
      });
    if (message === "close") {
      passes.close();
      await client.close();
      tools.close();
      hookServer.close();
      store.close();
      process.exit(0);
    }
  })().catch((error) => {
    log("fixture-error", { message: String(error) });
    process.send?.({ kind: "error", message: String(error) });
  });
});
