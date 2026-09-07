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
export { isBlueprintArtifactId } from "./blueprint-artifact.js";
export {
  validateBlueprintRepository,
  validateBlueprintToolRegistry,
} from "./blueprint-repository-validation.js";
export { GitBlueprintStore } from "./git-blueprint-store.js";
export type {
  BlueprintRepositoryTransaction,
  WorkingBlueprintArtifact,
} from "./git-blueprint-store.js";
export { LifecycleEngine } from "./lifecycle-engine.js";
export {
  boardStatusForMechanicalNode,
  validateBlueprintBoardStatuses,
} from "./blueprint.js";
export { LifecycleResolver } from "./lifecycle-resolver.js";
export { readLifecycleContext } from "./lifecycle-state.js";
export {
  readCompletedStageOutputs,
  type CompletedStageOperation,
  type CompletedStageOutput,
} from "./stage-output-history.js";
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
  LifecycleOutputContract,
  LifecyclePersistence,
  LifecycleSnapshot,
  MechanicalNodeUse,
  PendingTransition,
  RebaseLifecycleInput,
  ResumeLifecycleInput,
  StartLifecycleInput,
} from "./types.js";
export { mechanicalNodeUses } from "./types.js";

export const engine = "engine" as const;
