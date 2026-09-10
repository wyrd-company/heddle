// ---
// relationships:
//   verifies: heddle
// ---

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { toNodeHandler } from "@modelcontextprotocol/node";

import type { WorkflowMcpHttpHandler } from "../../mcp-server/workflow-mcp-handler.js";

export const startQualificationMcpServer = async () => {
  let current: WorkflowMcpHttpHandler | undefined;
  const handler = toNodeHandler({
    fetch: (request) =>
      current === undefined
        ? Promise.resolve(
            new globalThis.Response("MCP handler is not ready", {
              status: 503,
            }),
          )
        : current.fetch(request),
  });
  const server = createServer((request, response) => {
    void handler(request, response).catch((error: Error) =>
      response.destroy(error),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    use: (next: WorkflowMcpHttpHandler) => {
      current = next;
    },
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      }),
  };
};
