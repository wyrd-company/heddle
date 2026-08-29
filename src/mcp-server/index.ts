// ---
// relationships:
//   implements: heddle
// ---

export { workflowMcpCoreTools } from "./core-tools.js";
export { isWorkflowMcpStageContract } from "./stage-contract.js";
export {
  bearerCorrelationToken,
  CorrelationTokenError,
  WorkflowMcpSessionResolver,
} from "./session-binding.js";
export {
  createWorkflowMcpHttpHandler,
  type WorkflowMcpHttpHandler,
} from "./workflow-mcp-handler.js";
export type {
  CorrelationTokenMatch,
  WorkflowMcpDisposition,
  WorkflowMcpHandlerOptions,
  WorkflowMcpLifecycle,
  WorkflowMcpPersistence,
  WorkflowMcpSessionBinding,
  WorkflowMcpStageContract,
  WorkflowMcpToolContext,
  WorkflowMcpToolContributor,
} from "./types.js";

export const mcpServer = "mcp-server" as const;
