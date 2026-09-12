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
import { workflowMcpBoardTools } from "./board-tools.js";
import { EscalationCoordinator } from "./escalation-coordinator.js";
import { workflowMcpEscalationTools } from "./escalation-tools.js";
import { workflowMcpTodoTools } from "./todo-tools.js";
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
import { workflowMcpSubagentTools } from "../subagents/tools.js";

export interface WorkflowMcpHttpHandler {
  readonly bus: McpHttpHandler["bus"];
  close(): Promise<void>;
  fetch(request: globalThis.Request): Promise<globalThis.Response>;
  readonly notify: ServerNotifier;
  readonly toolNames: ReadonlySet<string>;
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
  for (const contributor of [
    ...workflowMcpCoreTools(),
    ...workflowMcpEscalationTools(),
    ...workflowMcpTodoTools(),
    ...additional,
  ]) {
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
  const resolver = new WorkflowMcpSessionResolver(options.persistence);
  const escalationCoordinator =
    options.escalationCoordinator ??
    new EscalationCoordinator({
      attention: {
        raise: async () => {
          throw new Error("Escalation attention routing is not configured");
        },
      },
      decisionLog: {
        record: async () => {
          throw new Error("Escalation decision logging is not configured");
        },
      },
      delivery: {
        deliver: async () => {
          throw new Error("Escalation answer delivery is not configured");
        },
      },
      pushover: {
        send: async () => {
          throw new Error("Escalation Pushover routing is not configured");
        },
      },
      session: {
        steer: async () => {
          throw new Error("Parent escalation routing is not configured");
        },
      },
      persistence: options.persistence,
    });
  const contributors = contributorsByName([
    ...(options.board === undefined
      ? []
      : workflowMcpBoardTools(options.board)),
    ...(options.subagentCoordinator === undefined
      ? []
      : workflowMcpSubagentTools(options.subagentCoordinator)),
    ...(options.tools ?? []),
  ]);
  const serverForBinding = (binding: WorkflowMcpSessionBinding): McpServer => {
    const server = new McpServer({ name: "heddle", version: "1.0.0" });
    for (const toolName of binding.stage.tools ?? []) {
      const contributor = contributors.get(toolName);
      if (contributor === undefined) {
        throw new Error(
          `Workflow stage '${binding.stage.id}' declares MCP tool '${toolName}' that is not registered`,
        );
      }
      contributor.register(server, {
        binding,
        escalationCoordinator,
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
    toolNames: new Set(contributors.keys()),
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
