// ---
// relationships:
//   implements:
//     - t3-code-client
//     - agent-tools
//     - node-types
// ---
import { UserInputAttachments } from "./attachments.js";
import { z } from "zod";
import {
  ApprovalRequestId,
  CheckpointRef,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
  forwardCompatibleLiteral,
} from "../../common.js";
import {
  ThreadPullRequestKey,
  ThreadPullRequestLink,
  ThreadPullRequestSnapshot,
  ThreadPullRequestStack,
} from "./pull-request-model.js";
import {
  ChatAttachment,
  ModelSelection,
  ProjectFaviconPath,
  ProjectIconOverride,
  ProjectScript,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderUserInputAnswers,
  RuntimeMode,
} from "../model.js";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  OrchestrationCheckpointFile,
  OrchestrationCheckpointStatus,
  OrchestrationMessageContext,
  OrchestrationMessageRole,
  OrchestrationProposedPlan,
  OrchestrationSession,
  OrchestrationThreadActivity,
  RepositoryIdentity,
  SourceProposedPlanReference,
  ThreadEnvMode,
  ThreadLinkedPullRequest,
  ThreadTitleRegeneration,
  ThreadTitleState,
} from "../read-model.js";

export const ProjectCreatedPayload = z.looseObject({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: RepositoryIdentity.nullable().optional(),
  defaultModelSelection: ModelSelection.nullable(),
  faviconPath: ProjectFaviconPath.nullable().optional(),
  projectIcon: ProjectIconOverride.nullable().optional(),
  scripts: z.array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectCreatedPayload = z.infer<typeof ProjectCreatedPayload>;
export const ProjectDeletedPayload = z.looseObject({
  projectId: ProjectId,
  deletedAt: IsoDateTime,
});
export type ProjectDeletedPayload = z.infer<typeof ProjectDeletedPayload>;
export const ProjectMetaUpdatedPayload = z.looseObject({
  projectId: ProjectId,
  title: TrimmedNonEmptyString.optional(),
  workspaceRoot: TrimmedNonEmptyString.optional(),
  repositoryIdentity: RepositoryIdentity.nullable().optional(),
  defaultModelSelection: ModelSelection.nullable().optional(),
  defaultThreadEnvMode: ThreadEnvMode.nullable().optional(),
  autoPull: z.boolean().optional(),
  faviconPath: ProjectFaviconPath.nullable().optional(),
  projectIcon: ProjectIconOverride.nullable().optional(),
  scripts: z.array(ProjectScript).optional(),
  updatedAt: IsoDateTime,
});
export type ProjectMetaUpdatedPayload = z.infer<typeof ProjectMetaUpdatedPayload>;
export const ThreadActivityAppendedPayload = z.looseObject({
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
});
export type ThreadActivityAppendedPayload = z.infer<typeof ThreadActivityAppendedPayload>;
export const ThreadApprovalResponseRequestedPayload = z.looseObject({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});
export type ThreadApprovalResponseRequestedPayload = z.infer<
  typeof ThreadApprovalResponseRequestedPayload
>;
export const ThreadArchivedPayload = z.looseObject({
  threadId: ThreadId,
  archivedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadArchivedPayload = z.infer<typeof ThreadArchivedPayload>;
export const ThreadCheckpointRevertRequestedPayload = z.looseObject({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  restoreFiles: z.boolean().optional(),
  createdAt: IsoDateTime,
});
export type ThreadCheckpointRevertRequestedPayload = z.infer<
  typeof ThreadCheckpointRevertRequestedPayload
>;
export const ThreadCreatedPayload = z.looseObject({
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode.default(DEFAULT_RUNTIME_MODE),
  interactionMode: ProviderInteractionMode.default(DEFAULT_PROVIDER_INTERACTION_MODE),
  branch: TrimmedNonEmptyString.nullable(),
  worktreePath: TrimmedNonEmptyString.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadCreatedPayload = z.infer<typeof ThreadCreatedPayload>;
export const ThreadDeletedPayload = z.looseObject({ threadId: ThreadId, deletedAt: IsoDateTime });
export type ThreadDeletedPayload = z.infer<typeof ThreadDeletedPayload>;
export const ThreadInteractionModeSetPayload = z.looseObject({
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode.default(DEFAULT_PROVIDER_INTERACTION_MODE),
  updatedAt: IsoDateTime,
});
export type ThreadInteractionModeSetPayload = z.infer<typeof ThreadInteractionModeSetPayload>;
export const ThreadMessageSentPayload = z.looseObject({
  threadId: ThreadId,
  messageId: MessageId,
  role: OrchestrationMessageRole,
  text: z.string(),
  attachments: z.array(ChatAttachment).optional(),
  context: OrchestrationMessageContext.optional(),
  turnId: TurnId.nullable(),
  streaming: z.boolean(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadMessageSentPayload = z.infer<typeof ThreadMessageSentPayload>;
export const ThreadMetaUpdatedPayload = z.looseObject({
  threadId: ThreadId,
  activeOrderKey: TrimmedNonEmptyString.nullable().optional(),
  title: TrimmedNonEmptyString.optional(),
  regenerateTitle: z.literal(true).optional(),
  previousTitle: TrimmedNonEmptyString.optional(),
  titleRegeneration: ThreadTitleRegeneration.nullable().optional(),
  titleState: ThreadTitleState.nullable().optional(),
  modelSelection: ModelSelection.optional(),
  branch: TrimmedNonEmptyString.nullable().optional(),
  worktreePath: TrimmedNonEmptyString.nullable().optional(),
  linkedPullRequest: ThreadLinkedPullRequest.nullable().optional(),
  branchPullRequest: ThreadLinkedPullRequest.nullable().optional(),
  updatedAt: IsoDateTime,
});
export type ThreadMetaUpdatedPayload = z.infer<typeof ThreadMetaUpdatedPayload>;
export const ThreadPinReorderedPayload = z.looseObject({
  threadId: ThreadId,
  orderKey: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});
export type ThreadPinReorderedPayload = z.infer<typeof ThreadPinReorderedPayload>;
export const ThreadPinnedPayload = z.looseObject({
  threadId: ThreadId,
  pinnedAt: IsoDateTime,
  pinOrderKey: TrimmedNonEmptyString.optional(),
  updatedAt: IsoDateTime,
});
export type ThreadPinnedPayload = z.infer<typeof ThreadPinnedPayload>;
export const ThreadProposedPlanUpsertedPayload = z.looseObject({
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
});
export type ThreadProposedPlanUpsertedPayload = z.infer<typeof ThreadProposedPlanUpsertedPayload>;
export const ThreadPullRequestLinkedPayload = z.looseObject({
  threadId: ThreadId,
  link: ThreadPullRequestLink,
  updatedAt: IsoDateTime,
});
export type ThreadPullRequestLinkedPayload = z.infer<typeof ThreadPullRequestLinkedPayload>;
export const ThreadPullRequestSyncedPayload = z.looseObject({
  threadId: ThreadId,
  ...ThreadPullRequestKey.shape,
  snapshot: ThreadPullRequestSnapshot,
  stack: ThreadPullRequestStack.nullable(),
  updatedAt: IsoDateTime,
});
export type ThreadPullRequestSyncedPayload = z.infer<typeof ThreadPullRequestSyncedPayload>;
export const ThreadPullRequestUnlinkedPayload = z.looseObject({
  threadId: ThreadId,
  ...ThreadPullRequestKey.shape,
  updatedAt: IsoDateTime,
});
export type ThreadPullRequestUnlinkedPayload = z.infer<typeof ThreadPullRequestUnlinkedPayload>;
export const ThreadRevertedPayload = z.looseObject({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
});
export type ThreadRevertedPayload = z.infer<typeof ThreadRevertedPayload>;
export const ThreadRuntimeModeSetPayload = z.looseObject({
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  updatedAt: IsoDateTime,
});
export type ThreadRuntimeModeSetPayload = z.infer<typeof ThreadRuntimeModeSetPayload>;
export const ThreadSessionSetPayload = z.looseObject({
  threadId: ThreadId,
  session: OrchestrationSession,
});
export type ThreadSessionSetPayload = z.infer<typeof ThreadSessionSetPayload>;
export const ThreadSessionStopRequestedPayload = z.looseObject({
  threadId: ThreadId,
  createdAt: IsoDateTime,
});
export type ThreadSessionStopRequestedPayload = z.infer<typeof ThreadSessionStopRequestedPayload>;
export const ThreadSettledPayload = z.looseObject({
  threadId: ThreadId,
  settledAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadSettledPayload = z.infer<typeof ThreadSettledPayload>;
export const ThreadSnoozedPayload = z.looseObject({
  threadId: ThreadId,
  snoozedUntil: IsoDateTime,
  snoozedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadSnoozedPayload = z.infer<typeof ThreadSnoozedPayload>;
export const ThreadTurnDiffCompletedPayload = z.looseObject({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: z.array(OrchestrationCheckpointFile),
  assistantMessageId: MessageId.nullable(),
  completedAt: IsoDateTime,
});
export type ThreadTurnDiffCompletedPayload = z.infer<typeof ThreadTurnDiffCompletedPayload>;
export const ThreadTurnInterruptRequestedPayload = z.looseObject({
  threadId: ThreadId,
  turnId: TurnId.optional(),
  createdAt: IsoDateTime,
});
export type ThreadTurnInterruptRequestedPayload = z.infer<
  typeof ThreadTurnInterruptRequestedPayload
>;
export const ThreadTurnStartRequestedPayload = z.looseObject({
  threadId: ThreadId,
  messageId: MessageId,
  modelSelection: ModelSelection.optional(),
  titleSeed: TrimmedNonEmptyString.optional(),
  runtimeMode: RuntimeMode.default(DEFAULT_RUNTIME_MODE),
  interactionMode: ProviderInteractionMode.default(DEFAULT_PROVIDER_INTERACTION_MODE),
  sourceProposedPlan: SourceProposedPlanReference.optional(),
  createdAt: IsoDateTime,
});
export type ThreadTurnStartRequestedPayload = z.infer<typeof ThreadTurnStartRequestedPayload>;
export const ThreadUnarchivedPayload = z.looseObject({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});
export type ThreadUnarchivedPayload = z.infer<typeof ThreadUnarchivedPayload>;
export const ThreadUnpinnedPayload = z.looseObject({ threadId: ThreadId, updatedAt: IsoDateTime });
export type ThreadUnpinnedPayload = z.infer<typeof ThreadUnpinnedPayload>;
export const ThreadUnsettledPayload = z.looseObject({
  threadId: ThreadId,
  reason: forwardCompatibleLiteral(["user", "activity"]),
  updatedAt: IsoDateTime,
});
export type ThreadUnsettledPayload = z.infer<typeof ThreadUnsettledPayload>;
export const ThreadUnsnoozedPayload = z.looseObject({
  threadId: ThreadId,
  reason: forwardCompatibleLiteral(["user", "activity"]),
  updatedAt: IsoDateTime,
});
export type ThreadUnsnoozedPayload = z.infer<typeof ThreadUnsnoozedPayload>;
export const ThreadUserInputResponseRequestedPayload = z.looseObject({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  attachmentsByQuestionId: UserInputAttachments.optional(),
  createdAt: IsoDateTime,
});
export type ThreadUserInputResponseRequestedPayload = z.infer<
  typeof ThreadUserInputResponseRequestedPayload
>;
