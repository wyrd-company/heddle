export {
  assembleStageHandoff,
  type RemediationHandoffStage,
  type ReviewStageOutput,
  type StageHandoffInput,
  type StandardHandoffStage,
} from "./handoff-assembler.js";
export {
  ensureCorrelationToken,
  type CorrelationTokenResult,
  type InstanceStateStore,
} from "./correlation-token.js";
export {
  bootstrapStageSession,
  harnessConfiguration,
  steerStageSession,
  type SessionBootstrapDependencies,
  type HarnessConfiguration,
  type SessionBootstrapInput,
  type SessionBootstrapResult,
  type SessionSteeringDependencies,
  type SessionSteeringInput,
  type SessionTemplateAuthority,
  type SessionT3Client,
} from "./session-bootstrap.js";
export {
  recordSessionActivation,
  sessionActivatedEvent,
  type SessionActivationEventStore,
  type SessionActivationPayload,
} from "./session-activation.js";
export {
  applyHarnessToolTimeoutBeforeThread,
  harnessToolTimeoutConfiguration,
  harnessToolTimeoutLaunchConfiguration,
  type HarnessToolTimeoutConsumer,
  type HarnessToolTimeoutConfiguration,
  type HarnessToolTimeoutLaunchConfiguration,
  type HarnessToolTimeoutLaunchInput,
} from "./harness-tool-timeout.js";
export {
  assertComposedSystemPrompt,
  composeSystemPrompt,
  HandoffRenderError,
  renderStageHandoff,
  type HandoffRenderInput,
} from "./handoff-renderer.js";
export {
  builtInSystemPrompt,
  resolveBuiltInSystemPrompt,
  type SystemPromptResolver,
} from "./system-prompt.js";
export {
  GitHandoffTemplateStore,
  HandoffTemplateError,
  type HandoffTemplateKind,
  type PinnedHandoffTemplate,
  type PinnedHandoffTemplateReference,
} from "./handoff-template-store.js";
export {
  ensureWorktree,
  type GitRunner,
  type PreparedWorktree,
  type WorktreeInput,
} from "./worktree-creator.js";
export {
  cleanupMergedChange,
  createMechanicalNodeEffects,
  ensureReviewSnapshot,
  mechanicalChangeContextKey,
  mechanicalNodeUses,
  mergeReviewSnapshot,
  type CleanupMergedChangeResult,
  type CommandRunner,
  type MechanicalBoardMirror,
  type MechanicalBoardStatuses,
  type MechanicalBoardStatusSource,
  type MechanicalChangeContext,
  type MechanicalNodeEffectOptions,
  type MergeSnapshotResult,
  type ReviewSnapshot,
} from "./mechanical-node-effects.js";
export {
  SessionObserver,
  type SessionObservationAttention,
  type SessionObservationAttentionQueue,
  type SessionObservationEscalations,
  type SessionObservationOptions,
  type SessionObservationPersistence,
  type SessionObservationResult,
  type SessionObservationT3Client,
  type SessionObservationTarget,
  type SessionObservationThresholds,
  type StopSessionInput,
} from "./session-observation.js";
export {
  T3ControlPlaneClient,
  type T3ControlPlaneClientOptions,
} from "./t3-control-plane-client.js";

export const controlPlane = "control-plane" as const;
