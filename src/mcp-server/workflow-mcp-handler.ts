// ---
// relationships:
//   implements: heddle
// ---

import {
  createMcpHandler,
  isLegacyRequest,
  McpServer,
  type McpHttpHandler,
  type ServerNotifier,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";

import { workflowMcpCoreTools } from "./core-tools.js";
import {
  bearerCorrelationToken,
  CorrelationTokenError,
  WorkflowMcpSessionResolver,
} from "./session-binding.js";
import type {
  WorkflowMcpHandlerOptions,
  WorkflowMcpSessionBinding,
  WorkflowMcpToolContributor,
} from "./types.js";

export interface WorkflowMcpHttpHandler {
  readonly bus: McpHttpHandler["bus"];
  close(): Promise<void>;
  fetch(request: globalThis.Request): Promise<globalThis.Response>;
  readonly notify: ServerNotifier;
}

const unauthorized = (): globalThis.Response =>
  new globalThis.Response(
    JSON.stringify({
      error: { code: -32_001, message: "Unauthorized" },
      id: null,
      jsonrpc: "2.0",
    }),
    {
      headers: {
        "content-type": "application/json",
        "www-authenticate": "Bearer",
      },
      status: 401,
    },
  );

const contributorsByName = (
  additional: readonly WorkflowMcpToolContributor[],
): Map<string, WorkflowMcpToolContributor> => {
  const contributors = new Map<string, WorkflowMcpToolContributor>();
  for (const contributor of [...workflowMcpCoreTools(), ...additional]) {
    if (contributors.has(contributor.name)) {
      throw new TypeError(
        `MCP tool contributor is registered more than once: ${contributor.name}`,
      );
    }
    contributors.set(contributor.name, contributor);
  }
  return contributors;
};

export const createWorkflowMcpHttpHandler = (
  options: WorkflowMcpHandlerOptions,
): WorkflowMcpHttpHandler => {
  const resolver = new WorkflowMcpSessionResolver(
    options.persistence,
    options.repositoryRoot,
  );
  const contributors = contributorsByName(options.tools ?? []);
  const serverForBinding = (binding: WorkflowMcpSessionBinding): McpServer => {
    const server = new McpServer({ name: "heddle", version: "1.0.0" });
    for (const toolName of binding.stage.tools ?? []) {
      contributors.get(toolName)?.register(server, {
        binding,
        lifecycle: options.lifecycle,
        persistence: options.persistence,
      });
    }
    return server;
  };
  const handler = createMcpHandler(async ({ requestInfo }) => {
    const token = bearerCorrelationToken(
      requestInfo?.headers.get("authorization") ?? null,
    );
    if (token === undefined) throw new CorrelationTokenError();
    const binding = await resolver.resolve(token);
    return serverForBinding(binding);
  });

  return {
    bus: handler.bus,
    close: handler.close,
    notify: handler.notify,
    fetch: async (request) => {
      const token = bearerCorrelationToken(
        request.headers.get("authorization"),
      );
      if (token === undefined) return unauthorized();
      let binding: WorkflowMcpSessionBinding;
      try {
        binding = await resolver.resolve(token);
      } catch (error) {
        if (error instanceof CorrelationTokenError) return unauthorized();
        throw error;
      }
      if (await isLegacyRequest(request)) {
        const server = serverForBinding(binding);
        const transport = new WebStandardStreamableHTTPServerTransport({
          enableJsonResponse: true,
          sessionIdGenerator: undefined,
        });
        await server.connect(transport);
        try {
          return await transport.handleRequest(request);
        } finally {
          await server.close();
        }
      }
      return handler.fetch(request);
    },
  };
};
