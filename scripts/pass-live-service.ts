// ---
// relationships:
//   verifies:
//     - node-types
//     - agent-tools
// ---
import { readFileSync, appendFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
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
import { fixtureHookEnvironment } from "./fixture-hook-environment.mjs";
const endpointId = (path: string) =>
  createHash("sha256")
    .update(path.replace(/\/policy$/, ""))
    .digest("hex");
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
const bindings = new Map<string, { path: string; token: string }>();
const releases: (() => void)[] = [];
const blueprint = config.blueprint as WorkflowBlueprint;
const engine = new WorkflowEngine(store, {
  resolveBlueprint: () => Promise.resolve(blueprint),
  nodes: {
    pass: async (context) => {
      try {
        return await passes.node(context);
      } catch (error) {
        log("node-error", { message: String(error) });
        throw error;
      }
    },
    finish: async () => null,
  },
  onBoundary: async (run) => {
    log("boundary", {
      status: run.status,
      awaiting: store
        .awaiting(run.id)
        .map((row) => ({ nodeId: row.nodeId, visit: row.visit })),
    });
    if (run.status === "awaiting") {
      const raw = store.db
        .prepare(
          "SELECT data FROM pass_invocations WHERE run_id=? ORDER BY rowid DESC LIMIT 1",
        )
        .get(run.id);
      if (raw) {
        const item = JSON.parse(String(raw["data"]));
        bindings.set(run.id, item.binding);
        if (item.binding)
          log("pass-endpoint", {
            runId: item.runId,
            nodeId: item.nodeId,
            visit: item.visit,
            threadId: item.threadId,
            endpointId: endpointId(item.binding.path),
          });
      }
    }
    const priorBinding = bindings.get(run.id);
    if (run.status === "resuming" && priorBinding) {
      const rejected = await fetch(
        `http://127.0.0.1:${config.port}${priorBinding.path}/policy`,
        { headers: { authorization: `Bearer ${priorBinding.token}` } },
      );
      log("terminal-token-rejection", { status: rejected.status });
      if (rejected.status !== 401)
        throw new Error("Terminal credential remained accepted");
      bindings.delete(run.id);
    }
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
      process.send?.({
        kind: "terminal",
        status: run.status,
        runId: run.id,
        at: Date.now(),
      });
  },
});
passes = new PassService(engine, {
  client,
  toolOrigin: `http://127.0.0.1:${config.port}`,
  defaultModel: config.model,
  toolOperations: {
    status: async (input) => {
      if (config.holdOnStatus) {
        process.send?.({ kind: "status-held", runId: input.runId });
        await new Promise<void>((resolve) => releases.push(resolve));
      }
    },
  },
  defaultWorktree: config.workspace,
  readArtifact: async () => {
    throw new Error("live fixture uses inline artifacts");
  },
});
const tools = createServer((request, response) => {
  const owner = store.db
    .prepare("SELECT data FROM pass_invocations")
    .all()
    .map((row) => JSON.parse(String(row["data"])))
    .find(
      (item) =>
        item.binding &&
        (request.url === item.binding.path ||
          request.url === `${item.binding.path}/policy`),
    );
  if (request.url?.endsWith("/policy")) log("policy-request");
  response.once("finish", () => {
    log("tool-response", {
      status: response.statusCode,
      endpointId: endpointId(request.url ?? ""),
      path: request.url?.endsWith("/policy") ? "policy" : "mcp",
      method: request.method,
      authorizationPresent: request.headers.authorization !== undefined,
      endpointOwner: owner
        ? {
            runId: owner.runId,
            nodeId: owner.nodeId,
            visit: owner.visit,
            threadId: owner.threadId,
          }
        : null,
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
const socket = fixtureHookEnvironment(config.profile).HEDDLE_HOOK_SOCKET;
rmSync(socket, { force: true });
const decide = hooks.decide.bind(hooks);
hooks.decide = async (sessionId) => {
  log("native-stop", { session_id: sessionId });
  const mapped = passes.sessions.resolve(sessionId);
  const result = await decide(sessionId);
  log("hook-decision", {
    session_id: sessionId,
    mapped: mapped
      ? {
          runId: mapped.runId,
          nodeId: mapped.nodeId,
          visit: mapped.visit,
          threadId: mapped.threadId,
        }
      : null,
    result,
  });
  if (!mapped)
    process.send?.({ kind: "terminal-stop", sessionId, at: Date.now() });
  return result;
};
const hookServer = createServer((request, response) => {
  response.once("finish", () => {
    log("hook-response", { status: response.statusCode });
  });
  void hooks.handle(request, response);
});
tools.listen(config.port, "127.0.0.1");
await once(tools, "listening");
await passes.recover();
hookServer.listen(socket);
await once(hookServer, "listening");
await engine.recover();
process.send?.({ kind: "ready" });
process.on("message", (message) => {
  void (async () => {
    if (message === "release")
      for (const release of releases.splice(0)) release();
    if (
      message === "start" ||
      (typeof message === "object" && message !== null && "start" in message)
    ) {
      const run = await engine.start({
        id: message === "start" ? "fixture" : String(message.start),
        blueprintId: blueprint.id,
        commit: "fixture-pinned",
        context: { item: "parcel" },
      });
      process.send?.({ kind: "started", status: run.status });
      if (config.qualifyApprovals) {
        const row = store.awaiting(run.id)[0];
        if (!row) throw new Error("missing pass");
        const id = String(row.details.threadId) as Parameters<
          typeof client.threads.watch
        >[0];
        void (async () => {
          for await (const update of client.threads.watch(id)) {
            if (
              update.kind === "event" &&
              update.event.type === "thread.activity-appended"
            ) {
              const activity = update.event.payload.activity;
              log("public-activity", {
                kind: activity.kind,
                sequence: update.event.sequence,
              });
              if (activity.kind === "approval.requested") {
                log("approval-before-response", {
                  request: activity.payload,
                  view: passes.read(run.id, row.nodeId, row.visit),
                });
                await client.threads.respondToApproval({
                  threadId: id,
                  requestId: (activity.payload as { requestId: string })
                    .requestId as never,
                  decision: "accept",
                });
              }
            }
            if (update.kind === "turn-settled")
              log("public-turn-settled", {
                state: update.outcome.state,
                turnId: update.outcome.turnId,
              });
          }
        })().catch((error) =>
          log("approval-fixture-error", { message: String(error) }),
        );
      }
    }
    if (message === "state")
      process.send?.({
        kind: "state",
        runs: store.list().map((run) => ({
          id: run.id,
          status: run.status,
          context: run.context,
        })),
        events: store.list().flatMap((run) =>
          store.events(run.id).map((event) => ({
            type: event.type,
            payload: event.type === "pause" ? undefined : event.payload,
          })),
        ),
        views: store.db
          .prepare("SELECT data FROM pass_invocations")
          .all()
          .map((row) => {
            const item = JSON.parse(String(row["data"]));
            return passes.read(item.runId, item.nodeId, item.visit);
          }),
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
