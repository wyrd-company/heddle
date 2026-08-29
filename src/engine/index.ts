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
  LifecyclePersistence,
  LifecycleSnapshot,
  PendingTransition,
  ResumeLifecycleInput,
  StartLifecycleInput,
} from "./types.js";

export const engine = "engine" as const;
