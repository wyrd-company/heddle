// ---
// relationships:
//   implements: heddle
// ---

import { Buffer } from "node:buffer";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import { KanbanBoardAdapter } from "../board-adapter/index.js";
import {
  createConsoleServer,
  type ConsoleAttention,
  type ConsoleAttentionActionPort,
  type ConsoleBlueprintEditor,
  type ConsoleBoard,
  type ConsoleEvent,
  type ConsoleInstance,
  ConsoleLifecycleUnavailableError,
  type ConsoleLifecycleSnapshot,
  type ConsoleStateSource,
} from "../console/index.js";
import {
  createWorkflowMcpHttpHandler,
  type WorkflowMcpHttpHandler,
} from "../mcp-server/index.js";
import { SqlitePersistence } from "../persistence/index.js";
import type { ProductionComposition } from "../production/index.js";

type DeploymentEnvironment = Record<string, string | undefined>;

export type HeddleDeploymentServer = {
  close(): Promise<void>;
  readonly port: number;
};

export type HeddleDeploymentServerOptions = {
  boardDirectory?: string;
  host: string;
  port: number;
  stateDirectory?: string;
};

export interface HeddleDeploymentComposition {
  board?: ConsoleBoard;
  consoleActions?: ConsoleAttentionActionPort;
  blueprintEditor?: ConsoleBlueprintEditor;
  consoleState?: ConsoleStateSource;
  production?: ProductionComposition;
  productionFactory?: () => ProductionComposition;
}

const taskInstance = /^task-([1-9][0-9]*)$/;
const maximumMcpRequestBytes = 1024 * 1024;

class McpRequestTooLargeError extends Error {}

class PersistenceConsoleStateSource implements ConsoleStateSource {
  public constructor(private readonly persistence: SqlitePersistence) {}

  public async listAttention(): Promise<ConsoleAttention[]> {
    // Durable attention is supplied by the production composition. Event
    // payloads are not a second attention authority.
    return [];
  }

  public async listCorrelationTokens(): Promise<string[]> {
    return this.persistence
      .listInstances()
      .flatMap(({ state }) => Object.values(state.correlationTokens));
  }

  public async listEvents(input: {
    afterSequence: number;
    instanceId?: string;
  }): Promise<ConsoleEvent[]> {
    const records = this.persistence
      .listInstances()
      .filter(
        ({ instanceId }) =>
          input.instanceId === undefined || instanceId === input.instanceId,
      );
    return records
      .flatMap(({ instanceId }) =>
        this.persistence.replayEvents(instanceId, input.afterSequence),
      )
      .sort((left, right) => left.sequence - right.sequence);
  }

  public async listInstances(): Promise<ConsoleInstance[]> {
    return this.persistence.listInstances().flatMap((record) => {
      const match = taskInstance.exec(record.instanceId);
      if (match === null) return [];
      const taskId = Number(match[1]);
      if (!Number.isSafeInteger(taskId)) return [];
      const context = record.state.flowcraftContext;
      const stageId =
        typeof context === "object" &&
        context !== null &&
        !Array.isArray(context) &&
        Array.isArray(context["awaitingNodeIds"]) &&
        typeof context["awaitingNodeIds"][0] === "string"
          ? context["awaitingNodeIds"][0]
          : undefined;
      return [
        {
          instanceId: record.instanceId,
          taskId,
          ...(stageId === undefined ? {} : { stageId }),
        },
      ];
    });
  }

  public async readLifecycle(input: {
    afterSequence: number;
    taskId: number;
  }): Promise<ConsoleLifecycleSnapshot> {
    void input;
    throw new ConsoleLifecycleUnavailableError(
      "Lifecycle canvas source is not active in this deployment composition",
    );
  }
}

const readBody = async (request: IncomingMessage): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += bytes.length;
    if (size > maximumMcpRequestBytes) {
      throw new McpRequestTooLargeError("MCP request body is too large");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
};

const toWebRequest = async (
  request: IncomingMessage,
  origin: string,
): Promise<globalThis.Request> => {
  const headers = new globalThis.Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const method = request.method ?? "GET";
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : Buffer.from(await readBody(request));
  const init: globalThis.RequestInit & { duplex?: "half" } = {
    body,
    duplex: body === undefined ? undefined : "half",
    headers,
    method,
  };
  return new globalThis.Request(
    new globalThis.URL(request.url ?? "/", origin),
    init,
  );
};

const writeWebResponse = async (
  response: globalThis.Response,
  target: ServerResponse,
): Promise<void> => {
  target.statusCode = response.status;
  response.headers.forEach((value, name) => target.setHeader(name, value));
  target.end(Buffer.from(await response.arrayBuffer()));
};

const requiredStateDirectory = (environment: DeploymentEnvironment): string => {
  const stateDirectory = environment["HEDDLE_STATE_PATH"]?.trim();
  if (!stateDirectory) throw new Error("HEDDLE_STATE_PATH must not be empty");
  return stateDirectory;
};

const requiredBoardDirectory = (environment: DeploymentEnvironment): string => {
  const boardDirectory =
    environment["HEDDLE_BOARD_PATH"]?.trim() || "/workspaces/kanban";
  if (!boardDirectory.startsWith("/")) {
    throw new Error("HEDDLE_BOARD_PATH must be an absolute path");
  }
  return boardDirectory;
};

const configuredPort = (environment: DeploymentEnvironment): number => {
  const value = environment["HEDDLE_PORT"] ?? "3774";
  if (!/^\d+$/.test(value)) throw new Error("HEDDLE_PORT must be an integer");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("HEDDLE_PORT must be between 0 and 65535");
  }
  return port;
};

const validateServerOptions = (
  options: HeddleDeploymentServerOptions,
  hasProduction: boolean,
): void => {
  if (options.host.trim() === "") {
    throw new Error("Heddle server host must not be empty");
  }
  if (
    !Number.isSafeInteger(options.port) ||
    options.port < 0 ||
    options.port > 65_535
  ) {
    throw new Error("Heddle server port must be between 0 and 65535");
  }
  if (!hasProduction) {
    if (options.boardDirectory === undefined) {
      throw new Error("Heddle board directory is required");
    }
    if (options.stateDirectory === undefined) {
      throw new Error("Heddle state directory is required");
    }
  }
};

export const startHeddleServer = async (
  options: HeddleDeploymentServerOptions,
  composition: HeddleDeploymentComposition = {},
): Promise<HeddleDeploymentServer> => {
  if (
    composition.production !== undefined &&
    composition.productionFactory !== undefined
  ) {
    throw new Error(
      "A production composition and production factory cannot both be supplied",
    );
  }
  const hasProduction =
    composition.production !== undefined ||
    composition.productionFactory !== undefined;
  validateServerOptions(options, hasProduction);
  if (
    hasProduction &&
    (composition.board !== undefined ||
      composition.blueprintEditor !== undefined ||
      composition.consoleActions !== undefined ||
      composition.consoleState !== undefined)
  ) {
    throw new Error(
      "A production composition owns its board and console state boundaries",
    );
  }
  const host = options.host.trim();
  type RequestHandler = (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<void>;
  let handleRequest: RequestHandler = async (_request, response) => {
    response.statusCode = 503;
    response.setHeader("content-type", "application/json");
    response.setHeader("retry-after", "1");
    response.end(JSON.stringify({ error: "Heddle service is starting" }));
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Unknown error",
        }),
      );
    });
  });
  const closeServer = async (): Promise<void> => {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  };
  let production = composition.production;
  let persistence: SqlitePersistence | undefined;
  let mcp: WorkflowMcpHttpHandler | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, host, resolve);
    });

    production ??= composition.productionFactory?.();
    const board =
      production?.board ??
      composition.board ??
      new KanbanBoardAdapter(options.boardDirectory!);
    persistence =
      production?.persistence ??
      new SqlitePersistence({
        stateDirectory: options.stateDirectory!,
      });
    mcp =
      production?.mcp ??
      createWorkflowMcpHttpHandler({
        lifecycle: {
          resume: () =>
            Promise.reject(
              new Error("The deployed lifecycle composition is not active"),
            ),
        },
        persistence,
      });
    const readyMcp = mcp;
    const consoleServer = createConsoleServer({
      ...(composition.consoleActions === undefined && production === undefined
        ? {}
        : {
            actions: production?.consoleActions ?? composition.consoleActions!,
          }),
      board,
      blueprintEditor:
        production?.blueprintEditor ?? composition.blueprintEditor,
      state:
        composition.consoleState ??
        production?.consoleState ??
        new PersistenceConsoleStateSource(persistence),
    });
    const readyHandler: RequestHandler = async (request, response) => {
      try {
        const url = new globalThis.URL(request.url ?? "/", `http://${host}`);
        if (url.pathname === "/mcp") {
          await writeWebResponse(
            await readyMcp.fetch(
              await toWebRequest(
                request,
                `http://${request.headers.host ?? host}`,
              ),
            ),
            response,
          );
          return;
        }
        consoleServer.emit("request", request, response);
      } catch (error) {
        response.statusCode =
          error instanceof McpRequestTooLargeError ? 413 : 500;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : "Unknown error",
          }),
        );
      }
    };
    await production?.start();
    handleRequest = readyHandler;
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Heddle server did not bind a TCP port");
    }
    let closed = false;
    return {
      port: address.port,
      close: async () => {
        if (closed) return;
        closed = true;
        await closeServer();
        if (production === undefined) {
          await mcp?.close();
          persistence?.close();
        } else {
          await production.close();
        }
      },
    };
  } catch (error) {
    await closeServer();
    if (production === undefined) {
      await mcp?.close();
      persistence?.close();
    } else {
      await production.close();
    }
    throw error;
  }
};

export const startHeddleServerFromEnvironment = async (
  environment: DeploymentEnvironment,
  composition: HeddleDeploymentComposition = {},
): Promise<HeddleDeploymentServer> =>
  startHeddleServer(
    {
      ...(composition.production === undefined
        ? {
            boardDirectory: requiredBoardDirectory(environment),
            stateDirectory: requiredStateDirectory(environment),
          }
        : {}),
      host: environment["HEDDLE_HOST"]?.trim() || "127.0.0.1",
      port: configuredPort(environment),
    },
    composition,
  );
