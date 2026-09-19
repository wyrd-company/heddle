// ---
// relationships:
//   supports: mcp-live-test
// ---
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const DEFAULT_TOOL_NAME = "record_probe_nonce";
const KNOWN_PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
]);

export interface McpFixtureCall {
  readonly name: unknown;
  readonly arguments: unknown;
  readonly receivedAt: number;
  readonly authorization: string | undefined;
}

export interface McpFixture {
  readonly endpoint: string;
  readonly calls: ReadonlyArray<McpFixtureCall>;
  stop(): Promise<void>;
}

interface JsonRpcMessage {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

export async function startMcpFixture(options: {
  readonly authorizationHeader: string;
  readonly toolName?: string;
  readonly host?: string;
}): Promise<McpFixture> {
  const calls: McpFixtureCall[] = [];
  const toolName = options.toolName ?? DEFAULT_TOOL_NAME;
  const host = options.host ?? "127.0.0.1";
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== options.authorizationHeader) {
      response.writeHead(401, { "www-authenticate": "Bearer" });
      response.end();
      return;
    }

    if (request.url !== "/mcp") {
      response.writeHead(404);
      response.end();
      return;
    }

    if (request.method === "GET") {
      response.writeHead(405, { allow: "POST" });
      response.end();
      return;
    }

    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" });
      response.end();
      return;
    }

    const message = await readMessage(request, response);
    if (message === undefined) return;

    if (message.method === "notifications/initialized") {
      response.writeHead(202);
      response.end();
      return;
    }

    if (message.method === "initialize") {
      const requestedVersion = protocolVersion(message.params);
      writeResult(response, message.id, {
        protocolVersion:
          requestedVersion !== undefined && KNOWN_PROTOCOL_VERSIONS.has(requestedVersion)
            ? requestedVersion
            : "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "t3code-client-mcp-fixture", version: "1.0.0" },
      });
      return;
    }

    if (message.method === "tools/list") {
      writeResult(response, message.id, {
        tools: [
          {
            name: toolName,
            description: "Record the probe nonce.",
            inputSchema: {
              type: "object",
              properties: { nonce: { type: "string" } },
              required: ["nonce"],
            },
          },
        ],
      });
      return;
    }

    if (message.method === "tools/call") {
      const params = asRecord(message.params);
      calls.push({
        name: params?.["name"],
        arguments: params?.["arguments"],
        receivedAt: Date.now(),
        authorization: request.headers.authorization,
      });
      writeResult(response, message.id, { content: [{ type: "text", text: "recorded" }] });
      return;
    }

    if (message.method === "ping") {
      writeResult(response, message.id, {});
      return;
    }

    writeJson(response, 200, {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("MCP fixture did not bind a TCP address.");
  }

  return {
    endpoint: `http://${host}:${address.port}/mcp`,
    calls,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

async function readMessage(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<JsonRpcMessage | undefined> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (asRecord(value) === undefined) throw new Error("JSON-RPC message must be an object.");
    return value as JsonRpcMessage;
  } catch {
    writeJson(response, 400, { error: "invalid_json_rpc" });
    return undefined;
  }
}

function protocolVersion(params: unknown): string | undefined {
  const value = asRecord(params)?.["protocolVersion"];
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function writeResult(response: ServerResponse, id: unknown, result: unknown): void {
  writeJson(response, 200, { jsonrpc: "2.0", id, result });
}

function writeJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}
