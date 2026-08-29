// ---
// relationships:
//   implements: heddle
// ---

export {
  buildKanbanProjection,
  parseConsoleScope,
  serializeConsoleScope,
} from "./projection.js";
export { buildDependencyGraphProjection } from "./dependency-graph.js";
export { buildConsoleLifecycleSnapshot } from "./lifecycle-read-model.js";
export type { ConsoleLifecycleReadInput } from "./lifecycle-read-model.js";
export type {
  DependencyGraphEdge,
  DependencyGraphNode,
  DependencyGraphProjection,
  DependencyNodeTreatment,
} from "./dependency-graph.js";
export type {
  ConsoleScope,
  KanbanProjection,
  ProjectedTask,
} from "./projection.js";
export { createConsoleServer } from "./server.js";
export type { ConsoleServerOptions } from "./server.js";
export type {
  ConsoleAttention,
  ConsoleBoard,
  ConsoleEvent,
  ConsoleInstance,
  ConsoleLifecycleBlueprint,
  ConsoleLifecycleEvent,
  ConsoleLifecycleSnapshot,
  ConsoleStateSource,
} from "./types.js";
export { ConsoleLifecycleUnavailableError } from "./types.js";

export const console = "console" as const;
