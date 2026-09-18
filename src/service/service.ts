// ---
// relationships:
//   implements:
//     - command-line-interface
//     - engine-and-run-model
// ---
import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { appClients } from "../binding/config.js";
import { GitHubBindingService } from "../binding/service.js";
import { PushoverDelivery } from "../binding/notify.js";
import { HookServer } from "../agent-tools/hook-server.js";
import { RunStore } from "../engine/store.js";
import { PassService } from "../pass/service.js";
import { T3Client, schemas } from "../t3code/index.js";
import type { EngineNode, Run } from "../engine/types.js";
import type { WorkflowEngine } from "../engine/engine.js";
import type { ResolvedServiceConfig } from "./config.js";
import { BlueprintCatalog } from "./blueprints.js";
import { acquireStoreLease } from "./lease.js";

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

function listenTcp(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
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
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
function secret(path: string): string {
  return readFileSync(path, "utf8").trim();
}

export async function startService(
  config: ResolvedServiceConfig,
  io: ServiceIo,
): Promise<RunningService> {
  mkdirSync(dirname(config.databasePath), { recursive: true, mode: 0o700 });
  const lease = acquireStoreLease(config.databasePath);
  let store: RunStore | undefined,
    tcp: Server | undefined,
    hooks: Server | undefined,
    passes: PassService | undefined,
    t3: T3Client | undefined,
    timer: NodeJS.Timeout | undefined;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let closing: Promise<void> | undefined;
  let signalHandler: (() => void) | undefined;
  let startupMessage: string;
  let engine: WorkflowEngine | undefined;
  try {
    store = new RunStore(config.databasePath);
    if (config.projects.length === 0 && config.pass === undefined) {
      timer = setInterval(() => {}, config.polling.intervalMs);
      startupMessage = `Heddle started with no bound projects; store=${config.databasePath}; poll=${String(config.polling.intervalMs)}ms`;
    } else {
      const catalog = new BlueprintCatalog(config.blueprints.repository);
      if (!config.pass)
        throw new Error(
          "pass configuration is required when projects are bound",
        );
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
      let boundary: ((run: Run) => Promise<void>) | undefined;
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
        () => Promise.resolve(catalog.list()),
        {
          resolveBlueprint: (commit, id) => catalog.resolve(commit, id),
          nodes: {
            policy: catalog.policyNode,
            pass: (context) => passNode(context),
          },
          onBoundary: (run) => boundary?.(run) ?? Promise.resolve(),
        },
        {
          ...(config.intake === undefined ? {} : { intake: config.intake }),
          ...(notification === undefined
            ? {}
            : { notifications: notification }),
        },
      );
      engine = binding.engine;
      let hookHandler: HookServer | undefined;
      tcp = createServer((request, response) => {
        void (async () => {
          if (
            request.url === "/webhook/github" &&
            request.method === "POST" &&
            config.webhook
          ) {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            await binding.events.webhook(
              String(request.headers["x-github-event"] ?? ""),
              String(request.headers["x-hub-signature-256"] ?? ""),
              Buffer.concat(chunks),
              secret(config.webhook.secretFile),
            );
            response.writeHead(202).end();
            return;
          }
          if (!passes) {
            response.writeHead(503).end();
            return;
          }
          await passes.tools.handle(request, response);
        })().catch((error) => {
          io.error(error instanceof Error ? error.message : String(error));
          if (!response.headersSent) response.writeHead(500).end();
        });
      });
      await listenTcp(tcp);
      const address = tcp.address();
      if (!address || typeof address === "string")
        throw new Error("Cannot resolve Heddle tool listener");
      const origin = `http://127.0.0.1:${String(address.port)}`;
      passes = new PassService(binding.engine, {
        client,
        toolOrigin: origin,
        defaultModel: schemas.orchestrationModel.ModelSelection.parse(
          config.pass.defaultModel,
        ),
        defaultWorktree: config.pass.defaultWorktree,
        readArtifact: (commit, id, path) => catalog.read(commit, id, path),
      });
      passNode = passes.node;
      boundary = passes.synchronize;
      await binding.engine.recover();
      await passes.recover();
      const hookSocket = join(config.stateDirectory, "hooks.sock");
      rmSync(hookSocket, { force: true });
      hookHandler = new HookServer(passes.sessions, origin);
      hooks = createServer(
        (request, response) => void hookHandler?.handle(request, response),
      );
      await listenSocket(hooks, hookSocket);
      await binding.start();
      timer = setInterval(
        () =>
          void Promise.all([binding.poll(), binding.engine.tick()]).catch(
            (error) =>
              io.error(
                `Heddle poll failed: ${error instanceof Error ? error.message : String(error)}`,
              ),
          ),
        config.polling.intervalMs,
      );
      startupMessage = `Heddle started; store=${config.databasePath}; poll=${String(config.polling.intervalMs)}ms; tools=${origin}; hooks=${hookSocket}`;
    }
    const close = async (): Promise<void> => {
      if (closing) return closing;
      closing = (async () => {
        if (timer) clearInterval(timer);
        passes?.close();
        if (hooks?.listening) await closeServer(hooks);
        if (tcp?.listening) await closeServer(tcp);
        await t3?.close();
        store?.close();
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
      void close().catch((error) => {
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
    if (timer) clearInterval(timer);
    passes?.close();
    if (hooks?.listening) await closeServer(hooks);
    if (tcp?.listening) await closeServer(tcp);
    await t3?.close();
    store?.close();
    lease.release();
    finish();
    throw error;
  }
}
