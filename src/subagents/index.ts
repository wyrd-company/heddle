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
  type ClaimTodoAssignmentInput,
  type DelegationStateStore,
} from "./delegation-state.js";
export { requireActiveAssignmentLineage } from "./delegation-authorization.js";
export { stopTodoAssignmentTree } from "./delegation-teardown.js";
export { scopedTodoItems, todoSubtreeIds } from "../todo/index.js";
export { workflowMcpSubagentTools } from "./tools.js";

export const subagents = "subagents" as const;
