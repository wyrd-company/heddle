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

type DeploymentEnvironment = Record<string, string | undefined>;

export type HeddleDeploymentServer = {
  close(): Promise<void>;
  readonly port: number;
};

export interface HeddleDeploymentComposition {
  board?: ConsoleBoard;
  consoleState?: ConsoleStateSource;
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

export const startHeddleServerFromEnvironment = async (
  environment: DeploymentEnvironment,
  composition: HeddleDeploymentComposition = {},
): Promise<HeddleDeploymentServer> => {
  const port = configuredPort(environment);
  const board =
    composition.board ??
    new KanbanBoardAdapter(requiredBoardDirectory(environment));
  const persistence = new SqlitePersistence({
    stateDirectory: requiredStateDirectory(environment),
  });
  const mcp: WorkflowMcpHttpHandler = createWorkflowMcpHttpHandler({
    lifecycle: {
      resume: () =>
        Promise.reject(
          new Error("The deployed lifecycle composition is not active"),
        ),
    },
    persistence,
  });
  const consoleServer = createConsoleServer({
    board,
    state:
      composition.consoleState ??
      new PersistenceConsoleStateSource(persistence),
  });
  const host = environment["HEDDLE_HOST"]?.trim() || "127.0.0.1";
  const server = createServer(async (request, response) => {
    try {
      const url = new globalThis.URL(request.url ?? "/", `http://${host}`);
      if (url.pathname === "/mcp") {
        await writeWebResponse(
          await mcp.fetch(
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
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    await mcp.close();
    persistence.close();
    throw error;
  }
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
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await mcp.close();
      persistence.close();
    },
  };
};
