// ---
// relationships:
//   implements: heddle
// ---

export {
  SubagentCoordinator,
  type SpawnSubagentInput,
  type SpawnSubagentResult,
  type SubagentCoordinatorOptions,
  type SubagentLiveness,
  type SubagentSessionPreparation,
} from "./coordinator.js";
export {
  assignmentForChild,
  claimTodoAssignment,
  mutateTodoAssignment,
  scopedTodoItems,
  todoSubtreeIds,
  type ClaimTodoAssignmentInput,
  type DelegationStateStore,
} from "./delegation-state.js";
export { workflowMcpSubagentTools } from "./tools.js";

export const subagents = "subagents" as const;
