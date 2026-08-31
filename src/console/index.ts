// ---
// relationships:
//   implements: heddle
// ---

export {
  buildKanbanProjection,
  parseConsoleScope,
  projectPublicBoardTask,
  serializeConsoleScope,
} from "./projection.js";
export {
  buildDependencyGraphProjection,
  projectDependencyGraphAttention,
} from "./dependency-graph.js";
export { buildConsoleLifecycleSnapshot } from "./lifecycle-read-model.js";
export {
  assertConsoleLifecycleRebaseCurrent,
  ConsoleLifecycleActionsUnavailableError,
  ConsoleLifecycleRebaseConflictError,
  parseConsoleLifecycleRebaseRequest,
} from "./lifecycle-rebase-contract.js";
export type { ConsoleBlueprintEditor } from "./blueprint-editor.js";
export type { ConsoleLifecycleReadInput } from "./lifecycle-read-model.js";
export type {
  DependencyGraphAttention,
  DependencyGraphEdge,
  DependencyGraphNode,
  DependencyGraphProjection,
  DependencyNodeTreatment,
} from "./dependency-graph.js";
export type {
  ConsoleScope,
  KanbanProjection,
  ProjectedTask,
  PublicBoardTask,
} from "./projection.js";
export { createConsoleServer } from "./server.js";
export type { ConsoleServerOptions } from "./server.js";
export {
  assertConsoleAttentionFingerprint,
  consoleAttentionDeepLink,
  consoleAttentionFingerprint,
  createConsoleAttention,
  ConsoleAttentionActionsUnavailableError,
  ConsoleAttentionConflictError,
  parseConsoleAttentionActionRequest,
  validateConsoleAttentionCatalog,
} from "./attention-contract.js";
export type {
  ConsoleAttention,
  ConsoleAttentionAction,
  ConsoleAttentionActionAnswers,
  ConsoleAttentionActionContract,
  ConsoleAttentionActionInput,
  ConsoleAttentionActionPort,
  ConsoleAttentionActionRequest,
  ConsoleAttentionQuestion,
  ConsoleAttentionScope,
  ConsoleBoard,
  ConsoleEvent,
  ConsoleInstance,
  ConsoleLifecycleActionPort,
  ConsoleLifecycleBlueprint,
  ConsoleLifecycleEvent,
  ConsoleLifecycleRebaseAvailability,
  ConsoleLifecycleRebaseRequest,
  ConsoleLifecycleSnapshot,
  ConsoleStateSource,
} from "./types.js";
export {
  ConsoleLifecycleNotStartedError,
  ConsoleLifecycleUnavailableError,
} from "./types.js";

export const console = "console" as const;
