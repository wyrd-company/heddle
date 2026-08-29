// ---
// relationships:
//   implements: heddle
// ---

export {
  BlueprintValidationError,
  InvalidDispositionError,
  TransitionConflictError,
  UnexpectedLandingError,
} from "./errors.js";
export { GitBlueprintStore } from "./git-blueprint-store.js";
export { LifecycleEngine } from "./lifecycle-engine.js";
export { LifecycleResolver } from "./lifecycle-resolver.js";
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
  ResumeLifecycleInput,
  StartLifecycleInput,
} from "./types.js";

export const engine = "engine" as const;
