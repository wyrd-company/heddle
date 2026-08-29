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

const html = (instanceCount: number): string => `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Heddle</title></head>
  <body>
    <main>
      <h1>Heddle</h1>
      <p data-instance-count="${instanceCount}">${instanceCount} persisted instance${instanceCount === 1 ? "" : "s"} loaded.</p>
      <p><a href="/api/instances">View instance state</a></p>
    </main>
  </body>
</html>`;

const readBody = async (request: IncomingMessage): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
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
): Promise<HeddleDeploymentServer> => {
  const port = configuredPort(environment);
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
  const host = environment["HEDDLE_HOST"]?.trim() || "127.0.0.1";
  const server = createServer(async (request, response) => {
    try {
      const url = new globalThis.URL(request.url ?? "/", `http://${host}`);
      if (url.pathname === "/") {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(html(persistence.listInstances().length));
        return;
      }
      if (url.pathname === "/api/instances") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({ instances: persistence.listInstances() }),
        );
        return;
      }
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
      response.statusCode = 404;
      response.end("Not found");
    } catch (error) {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Unknown error",
        }),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
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
