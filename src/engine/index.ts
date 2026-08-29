// ---
// relationships:
//   implements: heddle
// ---

export {
  BlueprintEditConflictError,
  BlueprintValidationError,
  InvalidDispositionError,
  RebaseInstanceNotAwaitingError,
  RebaseTargetNotAwaitableError,
  RebaseTargetNotFoundError,
  TransitionConflictError,
  UnexpectedLandingError,
} from "./errors.js";
export {
  BlueprintArtifactEditor,
  type BlueprintArtifactRevision,
  type SaveBlueprintArtifactInput,
} from "./blueprint-artifact-editor.js";
export { GitBlueprintStore } from "./git-blueprint-store.js";
export type { WorkingBlueprintArtifact } from "./git-blueprint-store.js";
export { LifecycleEngine } from "./lifecycle-engine.js";
export { LifecycleResolver } from "./lifecycle-resolver.js";
export { readLifecycleContext } from "./lifecycle-state.js";
export type {
  LifecycleResolution,
  LifecycleResolutionAttention,
  LifecycleSelectorTask,
  ResolvedLifecycle,
} from "./lifecycle-resolver.js";
export type {
  CompletedLifecycleOperation,
  ExpectedLanding,
  ExpectedLandings,
  LifecycleBlueprint,
  LifecycleContextRecord,
  LifecycleEdge,
  LifecycleEffect,
  LifecycleEffectInput,
  LifecycleEngineOptions,
  LifecycleNode,
  LifecyclePersistence,
  LifecycleSnapshot,
  PendingTransition,
  RebaseLifecycleInput,
  ResumeLifecycleInput,
  StartLifecycleInput,
} from "./types.js";

export const engine = "engine" as const;
