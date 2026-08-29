// ---
// relationships:
//   implements: heddle
// ---

export { workflowMcpCoreTools } from "./core-tools.js";
export { workflowMcpTodoTools } from "./todo-tools.js";
export {
  EscalationCoordinator,
  escalationAnswerSchema,
  escalationInputSchema,
  escalationQuestionSchema,
  type AnsweredEscalation,
  type EscalationAnswerInput,
  type EscalationAnswers,
  type EscalationAttention,
  type EscalationAttentionQueue,
  type EscalationCoordinatorOptions,
  type EscalationInput,
  type EscalationQuestion,
  type EscalationResult,
  type ParentEscalation,
  type ParentEscalationRouter,
  type PendingEscalation,
  type PushoverEscalationNotifier,
} from "./escalation-coordinator.js";
export { workflowMcpEscalationTools } from "./escalation-tools.js";
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
