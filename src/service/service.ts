// ---
// relationships:
//   implements:
//     - command-line-interface
//     - engine-and-run-model
// ---
import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { appClients } from "../binding/config.js";
import { GitHubEventHandler } from "../binding/delivery.js";
import { webhookServer } from "./webhook.js";
import { GitHubBindingService } from "../binding/service.js";
import { PushoverDelivery } from "../binding/notify.js";
import { HookServer } from "../agent-tools/hook-server.js";
import { RunStore } from "../engine/store.js";
import { PassService } from "../pass/service.js";
import { T3Client, schemas } from "../t3code/index.js";
import type { EngineNode, Run } from "../engine/types.js";
import type { WorkflowEngine } from "../engine/engine.js";
import {
  AGENT_TOOLS_LISTEN_REQUIRED,
  type ResolvedServiceConfig,
} from "./config.js";
import { BlueprintCatalog } from "./blueprints.js";
import { acquireStoreLease } from "./lease.js";
import { serviceDatabasePath, serviceHookSocket } from "./identity.js";

export interface ServiceIo {
  error(message: string): void;
  output(message: string): void;
}
export interface RunningService {
  close(): Promise<void>;
  done: Promise<void>;
  origin?: string;
  engine?: WorkflowEngine;
}

function listenTcp(
  server: Server,
  port = 0,
  host = "127.0.0.1",
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
function listenSocket(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
function secret(path: string): string {
  return readFileSync(path, "utf8").trim();
}

export async function startService(
  config: ResolvedServiceConfig,
  io: ServiceIo,
): Promise<RunningService> {
  mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(config.databasePath), { recursive: true, mode: 0o700 });
  const databasePath = serviceDatabasePath(config.databasePath);
  const lease = acquireStoreLease(databasePath);
  let ready = false;
  let store: RunStore | undefined,
    tcp: Server | undefined,
    webhook: Server | undefined,
    hooks: Server | undefined,
    passes: PassService | undefined,
    t3: T3Client | undefined,
    timer: NodeJS.Timeout | undefined;
  let polling: Promise<void> | undefined, hookSocket: string | undefined;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let closing: Promise<void> | undefined;
  let signalHandler: (() => void) | undefined;
  let startupMessage: string;
  let engine: WorkflowEngine | undefined;
  // An idle service has no bound instance to update from a signed delivery.
  let events = new GitHubEventHandler(() => Promise.resolve(false));
  try {
    store = new RunStore(databasePath);
    if (config.projects.length === 0 && config.pass === undefined) {
      timer = setInterval(() => undefined, config.polling.intervalMs);
      startupMessage = `Heddle started with no bound projects; store=${config.databasePath}; poll=${String(config.polling.intervalMs)}ms`;
    } else {
      const catalog = new BlueprintCatalog(config.blueprints.repository);
      if (!config.pass)
        throw new Error(
          "pass configuration is required when projects are bound",
        );
      const listen = config.agentTools?.listen;
      if (!listen) throw new Error(AGENT_TOOLS_LISTEN_REQUIRED);
      const client = T3Client.create({
        baseUrl: config.t3Code.endpoint,
        ...(config.t3Code.tokenFile === undefined
          ? {}
          : { accessToken: secret(config.t3Code.tokenFile) }),
        clientLabel: "heddle",
      });
      t3 = client;
      let passNode: EngineNode = () =>
        Promise.reject(new Error("Pass service is not ready"));
      const lifecycle: {
        boundary?: (run: Run) => Promise<void>;
      } = {};
      const notification =
        config.notifications === undefined
          ? undefined
          : (() => {
              const value = JSON.parse(
                secret(config.notifications.pushoverCredentialFile),
              ) as { token: string; user: string };
              return new PushoverDelivery(value);
            })();
      const budget = { graphql: 0, rest: 0, mutations: 0 };
      const clients =
        config.projects.length === 0
          ? () => {
              throw new Error("No GitHub projects are bound");
            }
          : appClients(config.github.credentialFile, budget);
      const binding = new GitHubBindingService(
        store,
        config.projects,
        clients,
        () => catalog.list(config.intake?.commit),
        {
          pinCommit: (revision) => catalog.pin(revision),
          resolveBlueprint: (commit, id) => catalog.resolve(commit, id),
          nodes: {
            policy: catalog.policyNode,
            pass: (context) => passNode(context),
          },
          onBoundary: (run) => lifecycle.boundary?.(run) ?? Promise.resolve(),
        },
        {
          ...(config.intake === undefined ? {} : { intake: config.intake }),
          ...(notification === undefined
            ? {}
            : { notifications: notification, templates: catalog }),
        },
      );
      engine = binding.engine;
      events = binding.events;
      tcp = createServer((request, response) => {
        void (async () => {
          if (!ready) {
            response.writeHead(503).end();
            return;
          }
          if (!passes) {
            response.writeHead(503).end();
            return;
          }
          await passes.tools.handle(request, response);
        })().catch((error: unknown) => {
          io.error(error instanceof Error ? error.message : String(error));
          if (!response.headersSent) response.writeHead(500).end();
        });
      });
      await listenTcp(tcp, listen.port, listen.host);
      const toolHost = listen.host.includes(":")
        ? `[${listen.host}]`
        : listen.host;
      const origin = `http://${toolHost}:${String(listen.port)}`;
      passes = new PassService(binding.engine, {
        client,
        toolOrigin: origin,
        defaultModel: schemas.orchestrationModel.ModelSelection.parse(
          config.pass.defaultModel,
        ),
        defaultWorktree: config.pass.defaultWorktree,
        templates: catalog,
      });
      passNode = passes.node;
      lifecycle.boundary = passes.synchronize;
      await binding.engine.recover();
      await passes.recover();
      hookSocket = serviceHookSocket(config.stateDirectory, databasePath);
      rmSync(hookSocket, { force: true });
      const hookHandler = new HookServer(passes.sessions, origin);
      hooks = createServer((request, response) => {
        void hookHandler.handle(request, response);
      });
      await listenSocket(hooks, hookSocket);
      ready = true;
      await binding.start();
      const poll = (): void => {
        if (polling) return;
        polling = (async () => {
          await binding.poll();
          await binding.engine.tick();
        })()
          .catch((error: unknown) => {
            io.error(
              `Heddle poll failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          })
          .finally(() => {
            polling = undefined;
          });
      };
      timer = setInterval(poll, config.polling.intervalMs);
      startupMessage = `Heddle started; store=${config.databasePath}; poll=${String(config.polling.intervalMs)}ms; hooks=${hookSocket}`;
    }
    if (config.webhook?.listen) {
      const { secretFile } = config.webhook;
      webhook = webhookServer(events, () => secret(secretFile), io);
      const { host, port } = config.webhook.listen;
      await listenTcp(webhook, port, host);
      const urlHost = host.includes(":") ? `[${host}]` : host;
      startupMessage += `; webhook=http://${urlHost}:${String(port)}/webhook/github`;
    } else {
      startupMessage += "; webhook=disabled";
    }
    const close = async (): Promise<void> => {
      if (closing) return closing;
      ready = false;
      closing = (async () => {
        if (timer) clearInterval(timer);
        if (webhook?.listening) await closeServer(webhook);
        if (hooks?.listening) await closeServer(hooks);
        if (tcp?.listening) await closeServer(tcp);
        await polling;
        passes?.close();
        await t3?.close();
        store?.close();
        if (hookSocket) rmSync(hookSocket, { force: true });
        lease.release();
        if (signalHandler) {
          process.off("SIGINT", signalHandler);
          process.off("SIGTERM", signalHandler);
        }
        finish();
      })();
      return closing;
    };
    signalHandler = () => {
      void close().catch((error: unknown) => {
        io.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
        finish();
      });
    };
    process.once("SIGINT", signalHandler);
    process.once("SIGTERM", signalHandler);
    io.output(startupMessage);
    return { close, done, ...(engine === undefined ? {} : { engine }) };
  } catch (error) {
    ready = false;
    if (timer) clearInterval(timer);
    passes?.close();
    if (webhook?.listening) await closeServer(webhook);
    if (hooks?.listening) await closeServer(hooks);
    if (tcp?.listening) await closeServer(tcp);
    await polling;
    await t3?.close();
    store?.close();
    if (hookSocket) rmSync(hookSocket, { force: true });
    lease.release();
    finish();
    throw error;
  }
}
