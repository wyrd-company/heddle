// ---
// relationships:
//   implements:
//     - t3-code-client
//     - agent-tools
//     - node-types
// ---
import { z } from "zod";
import {
  ApprovalRequestId,
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "../../common.js";
import { UserInputAttachments } from "./attachments.js";
import {
  ChatAttachment,
  ModelSelection,
  ProviderUserInputAnswers,
  UploadChatAttachment,
} from "../model.js";
import { OrchestrationMessageContext, SourceProposedPlanReference } from "../read-model.js";

export const ThreadTurnStartBootstrapCreateThread = z.looseObject({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: z.enum(["approval-required", "auto-accept-edits", "auto", "full-access"]),
  interactionMode: z.enum(["default", "plan"]),
  branch: TrimmedNonEmptyString.nullable(),
  worktreePath: TrimmedNonEmptyString.nullable(),
  createdAt: IsoDateTime,
});
export type ThreadTurnStartBootstrapCreateThread = z.infer<
  typeof ThreadTurnStartBootstrapCreateThread
>;
export const ThreadTurnStartBootstrapPrepareWorktree = z.looseObject({
  projectCwd: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString.optional(),
  startFromOrigin: z.boolean().optional(),
});
export type ThreadTurnStartBootstrapPrepareWorktree = z.infer<
  typeof ThreadTurnStartBootstrapPrepareWorktree
>;
export const ThreadTurnStartBootstrap = z.looseObject({
  createThread: ThreadTurnStartBootstrapCreateThread.optional(),
  prepareWorktree: ThreadTurnStartBootstrapPrepareWorktree.optional(),
  runSetupScript: z.boolean().optional(),
});
export type ThreadTurnStartBootstrap = z.infer<typeof ThreadTurnStartBootstrap>;
export const ClientThreadTurnStartCommand = z.looseObject({
  type: z.literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: z.looseObject({
    messageId: MessageId,
    role: z.literal("user"),
    text: z.string(),
    attachments: z.array(z.union([UploadChatAttachment, ChatAttachment])),
    context: OrchestrationMessageContext.optional(),
  }),
  modelSelection: ModelSelection.optional(),
  titleSeed: TrimmedNonEmptyString.optional(),
  runtimeMode: z.enum(["approval-required", "auto-accept-edits", "auto", "full-access"]),
  interactionMode: z.enum(["default", "plan"]),
  bootstrap: ThreadTurnStartBootstrap.optional(),
  sourceProposedPlan: SourceProposedPlanReference.optional(),
  createdAt: IsoDateTime,
});
export type ClientThreadTurnStartCommand = z.infer<typeof ClientThreadTurnStartCommand>;
export const ThreadApprovalRespondCommand = z.looseObject({
  type: z.literal("thread.approval.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: z.enum(["accept", "acceptForSession", "acceptAlways", "decline", "cancel"]),
  createdAt: IsoDateTime,
});
export type ThreadApprovalRespondCommand = z.infer<typeof ThreadApprovalRespondCommand>;
export const ThreadCheckpointRevertCommand = z.looseObject({
  type: z.literal("thread.checkpoint.revert"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type ThreadCheckpointRevertCommand = z.infer<typeof ThreadCheckpointRevertCommand>;
export const ThreadConversationRevertCommand = z.looseObject({
  ...ThreadCheckpointRevertCommand.shape,
  type: z.literal("thread.conversation.revert"),
});
export type ThreadConversationRevertCommand = z.infer<typeof ThreadConversationRevertCommand>;
export const ThreadSessionStopCommand = z.looseObject({
  type: z.literal("thread.session.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
  onlyIfSettled: z.boolean().optional(),
});
export type ThreadSessionStopCommand = z.infer<typeof ThreadSessionStopCommand>;
export const ThreadTurnInterruptCommand = z.looseObject({
  type: z.literal("thread.turn.interrupt"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId.optional(),
  createdAt: IsoDateTime,
});
export type ThreadTurnInterruptCommand = z.infer<typeof ThreadTurnInterruptCommand>;
export const ThreadUserInputDismissCommand = z.looseObject({
  type: z.literal("thread.user-input.dismiss"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  createdAt: IsoDateTime,
});
export type ThreadUserInputDismissCommand = z.infer<typeof ThreadUserInputDismissCommand>;
export const ThreadUserInputRespondCommand = z.looseObject({
  type: z.literal("thread.user-input.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  attachmentsByQuestionId: UserInputAttachments.optional(),
  createdAt: IsoDateTime,
});
export type ThreadUserInputRespondCommand = z.infer<typeof ThreadUserInputRespondCommand>;

/** Persisted turn-start shape; client commands additionally accept upload attachments. */
export const ThreadTurnStartCommand = z.looseObject({
  ...ClientThreadTurnStartCommand.shape,
  message: ClientThreadTurnStartCommand.shape.message.safeExtend({
    attachments: z.array(ChatAttachment),
  }),
  runtimeMode: z
    .enum(["approval-required", "auto-accept-edits", "auto", "full-access"])
    .default("full-access"),
  interactionMode: z.enum(["default", "plan"]).default("default"),
});
export type ThreadTurnStartCommand = z.infer<typeof ThreadTurnStartCommand>;
