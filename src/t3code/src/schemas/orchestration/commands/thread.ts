// ---
// relationships:
//   implements:
//     - t3-code-client
//     - agent-tools
//     - node-types
// ---
import { z } from "zod";
import {
  CommandId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../../common.js";
import { ThreadPullRequestKey, ThreadPullRequestLinkSource } from "./pull-request-model.js";
import { ModelSelection } from "../model.js";
import { DEFAULT_PROVIDER_INTERACTION_MODE, ThreadLinkedPullRequest } from "../read-model.js";

export const ThreadActiveReorderCommand = z.looseObject({
  type: z.literal("thread.active.reorder"),
  commandId: CommandId,
  threadId: ThreadId,
  orderKey: TrimmedNonEmptyString,
});
export type ThreadActiveReorderCommand = z.infer<typeof ThreadActiveReorderCommand>;
export const ThreadArchiveCommand = z.looseObject({
  type: z.literal("thread.archive"),
  commandId: CommandId,
  threadId: ThreadId,
});
export type ThreadArchiveCommand = z.infer<typeof ThreadArchiveCommand>;
export const ThreadCreateCommand = z.looseObject({
  type: z.literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: z.enum(["approval-required", "auto-accept-edits", "auto", "full-access"]),
  interactionMode: z.enum(["default", "plan"]).default(DEFAULT_PROVIDER_INTERACTION_MODE),
  branch: TrimmedNonEmptyString.nullable(),
  worktreePath: TrimmedNonEmptyString.nullable(),
  createdAt: IsoDateTime,
  historyImport: z.literal(true).optional(),
});
export type ThreadCreateCommand = z.infer<typeof ThreadCreateCommand>;
export const ThreadDeleteCommand = z.looseObject({
  type: z.literal("thread.delete"),
  commandId: CommandId,
  threadId: ThreadId,
});
export type ThreadDeleteCommand = z.infer<typeof ThreadDeleteCommand>;
export const ThreadInteractionModeSetCommand = z.looseObject({
  type: z.literal("thread.interaction-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  interactionMode: z.enum(["default", "plan"]),
  createdAt: IsoDateTime,
});
export type ThreadInteractionModeSetCommand = z.infer<typeof ThreadInteractionModeSetCommand>;
export const ThreadMetaUpdateCommand = z
  .looseObject({
    type: z.literal("thread.meta.update"),
    commandId: CommandId,
    threadId: ThreadId,
    title: TrimmedNonEmptyString.optional(),
    regenerateTitle: z.literal(true).optional(),
    modelSelection: ModelSelection.optional(),
    branch: TrimmedNonEmptyString.nullable().optional(),
    expectedBranch: TrimmedNonEmptyString.nullable().optional(),
    worktreePath: TrimmedNonEmptyString.nullable().optional(),
    linkedPullRequest: ThreadLinkedPullRequest.nullable().optional(),
  })
  .refine(
    (input) => !(input.title !== undefined && input.regenerateTitle === true),
    "title and regenerateTitle cannot be specified together",
  );
export type ThreadMetaUpdateCommand = z.infer<typeof ThreadMetaUpdateCommand>;
export const ThreadPinCommand = z.looseObject({
  type: z.literal("thread.pin"),
  commandId: CommandId,
  threadId: ThreadId,
  orderKey: TrimmedNonEmptyString.optional(),
});
export type ThreadPinCommand = z.infer<typeof ThreadPinCommand>;
export const ThreadPinReorderCommand = z.looseObject({
  type: z.literal("thread.pin.reorder"),
  commandId: CommandId,
  threadId: ThreadId,
  orderKey: TrimmedNonEmptyString,
});
export type ThreadPinReorderCommand = z.infer<typeof ThreadPinReorderCommand>;
export const ThreadPullRequestLinkCommand = z.looseObject({
  type: z.literal("thread.pull-request.link"),
  commandId: CommandId,
  threadId: ThreadId,
  ...ThreadPullRequestKey.shape,
  url: TrimmedNonEmptyString,
  source: ThreadPullRequestLinkSource,
});
export type ThreadPullRequestLinkCommand = z.infer<typeof ThreadPullRequestLinkCommand>;
export const ThreadPullRequestUnlinkCommand = z.looseObject({
  type: z.literal("thread.pull-request.unlink"),
  commandId: CommandId,
  threadId: ThreadId,
  ...ThreadPullRequestKey.shape,
});
export type ThreadPullRequestUnlinkCommand = z.infer<typeof ThreadPullRequestUnlinkCommand>;
export const ThreadRuntimeModeSetCommand = z.looseObject({
  type: z.literal("thread.runtime-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  runtimeMode: z.enum(["approval-required", "auto-accept-edits", "auto", "full-access"]),
  createdAt: IsoDateTime,
});
export type ThreadRuntimeModeSetCommand = z.infer<typeof ThreadRuntimeModeSetCommand>;
export const ThreadSettleCommand = z.looseObject({
  type: z.literal("thread.settle"),
  commandId: CommandId,
  threadId: ThreadId,
});
export type ThreadSettleCommand = z.infer<typeof ThreadSettleCommand>;
export const ThreadSnoozeCommand = z.looseObject({
  type: z.literal("thread.snooze"),
  commandId: CommandId,
  threadId: ThreadId,
  snoozedUntil: IsoDateTime,
});
export type ThreadSnoozeCommand = z.infer<typeof ThreadSnoozeCommand>;
export const ThreadUnarchiveCommand = z.looseObject({
  type: z.literal("thread.unarchive"),
  commandId: CommandId,
  threadId: ThreadId,
});
export type ThreadUnarchiveCommand = z.infer<typeof ThreadUnarchiveCommand>;
export const ThreadUnpinCommand = z.looseObject({
  type: z.literal("thread.unpin"),
  commandId: CommandId,
  threadId: ThreadId,
});
export type ThreadUnpinCommand = z.infer<typeof ThreadUnpinCommand>;
export const ThreadUnsettleCommand = z.looseObject({
  type: z.literal("thread.unsettle"),
  commandId: CommandId,
  threadId: ThreadId,
  reason: z.literal("user"),
});
export type ThreadUnsettleCommand = z.infer<typeof ThreadUnsettleCommand>;
export const ThreadUnsnoozeCommand = z.looseObject({
  type: z.literal("thread.unsnooze"),
  commandId: CommandId,
  threadId: ThreadId,
  reason: z.literal("user"),
});
export type ThreadUnsnoozeCommand = z.infer<typeof ThreadUnsnoozeCommand>;
