// ---
// relationships:
//   implements: heddle
// ---

export { workflowMcpCoreTools } from "./core-tools.js";
export { workflowMcpBoardTools } from "./board-tools.js";
export { workflowMcpTodoTools } from "./todo-tools.js";
export {
  EscalationCoordinator,
  escalationAnswerSchema,
  escalationInputSchema,
  escalationQuestionSchema,
  type AnsweredEscalation,
  type AdjudicationEscalationRouter,
  type EscalationAnswerInput,
  type EscalationAnswerDelivery,
  type EscalationAnsweringAuthority,
  type EscalationAnswers,
  type EscalationAttention,
  type EscalationAttentionQueue,
  type EscalationCoordinatorOptions,
  type EscalationDecisionLog,
  type EscalationInput,
  type EscalationQuestion,
  type EscalationResult,
  type ParentEscalation,
  type PendingEscalation,
  type PushoverEscalationNotifier,
  type SessionEscalation,
  type SessionEscalationRouter,
} from "./escalation-coordinator.js";
export { escalationKey } from "./escalation-contract.js";
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
  WorkflowMcpBoardAuthority,
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
