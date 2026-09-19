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
  EventId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ProviderItemId,
  ThreadId,
  TrimmedNonEmptyString,
  forwardCompatibleLiteral,
  taggedUnionWithUnknown,
} from "../common.js";
import {
  ProjectCreatedPayload,
  ProjectDeletedPayload,
  ProjectMetaUpdatedPayload,
  ThreadActivityAppendedPayload,
  ThreadApprovalResponseRequestedPayload,
  ThreadArchivedPayload,
  ThreadCheckpointRevertRequestedPayload,
  ThreadCreatedPayload,
  ThreadDeletedPayload,
  ThreadInteractionModeSetPayload,
  ThreadMessageSentPayload,
  ThreadMetaUpdatedPayload,
  ThreadPinReorderedPayload,
  ThreadPinnedPayload,
  ThreadProposedPlanUpsertedPayload,
  ThreadPullRequestLinkedPayload,
  ThreadPullRequestSyncedPayload,
  ThreadPullRequestUnlinkedPayload,
  ThreadRevertedPayload,
  ThreadRuntimeModeSetPayload,
  ThreadSessionSetPayload,
  ThreadSessionStopRequestedPayload,
  ThreadSettledPayload,
  ThreadSnoozedPayload,
  ThreadTurnDiffCompletedPayload,
  ThreadTurnInterruptRequestedPayload,
  ThreadTurnStartRequestedPayload,
  ThreadUnarchivedPayload,
  ThreadUnpinnedPayload,
  ThreadUnsettledPayload,
  ThreadUnsnoozedPayload,
  ThreadUserInputResponseRequestedPayload,
} from "./commands/event-payloads.js";

export const OrchestrationAggregateKind = forwardCompatibleLiteral(["project", "thread"]);
export type OrchestrationAggregateKind = z.infer<typeof OrchestrationAggregateKind>;
export const OrchestrationClientOrigin = z.looseObject({
  surface: forwardCompatibleLiteral(["web", "desktop", "mobile", "cli"]).optional(),
  appVersion: TrimmedNonEmptyString.optional(),
});
export type OrchestrationClientOrigin = z.infer<typeof OrchestrationClientOrigin>;
export const OrchestrationEventMetadata = z.looseObject({
  providerTurnId: TrimmedNonEmptyString.optional(),
  providerItemId: ProviderItemId.optional(),
  adapterKey: TrimmedNonEmptyString.optional(),
  requestId: ApprovalRequestId.optional(),
  ingestedAt: IsoDateTime.optional(),
  historyImport: z.boolean().optional(),
  deferredTurn: z.boolean().optional(),
  origin: OrchestrationClientOrigin.optional(),
});
export type OrchestrationEventMetadata = z.infer<typeof OrchestrationEventMetadata>;
export const EventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: z.union([ProjectId, ThreadId]),
  occurredAt: IsoDateTime,
  commandId: CommandId.nullable(),
  causationEventId: EventId.nullable(),
  correlationId: CommandId.nullable(),
  metadata: OrchestrationEventMetadata,
};
export const OrchestrationEvent = taggedUnionWithUnknown("type", [
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("project.created"),
    payload: ProjectCreatedPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("project.meta-updated"),
    payload: ProjectMetaUpdatedPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("project.deleted"),
    payload: ProjectDeletedPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.created"),
    payload: ThreadCreatedPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.deleted"),
    payload: ThreadDeletedPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.archived"),
    payload: ThreadArchivedPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.unarchived"),
    payload: ThreadUnarchivedPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.settled"),
    payload: ThreadSettledPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.unsettled"),
    payload: ThreadUnsettledPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.snoozed"),
    payload: ThreadSnoozedPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.unsnoozed"),
    payload: ThreadUnsnoozedPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.pinned"),
    payload: ThreadPinnedPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.unpinned"),
    payload: ThreadUnpinnedPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.pin-reordered"),
    payload: ThreadPinReorderedPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.meta-updated"),
    payload: ThreadMetaUpdatedPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.pull-request-linked"),
    payload: ThreadPullRequestLinkedPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.pull-request-unlinked"),
    payload: ThreadPullRequestUnlinkedPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.pull-request-synced"),
    payload: ThreadPullRequestSyncedPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.runtime-mode-set"),
    payload: ThreadRuntimeModeSetPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.interaction-mode-set"),
    payload: ThreadInteractionModeSetPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.message-sent"),
    payload: ThreadMessageSentPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.turn-start-requested"),
    payload: ThreadTurnStartRequestedPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.turn-interrupt-requested"),
    payload: ThreadTurnInterruptRequestedPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.approval-response-requested"),
    payload: ThreadApprovalResponseRequestedPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.user-input-response-requested"),
    payload: ThreadUserInputResponseRequestedPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.checkpoint-revert-requested"),
    payload: ThreadCheckpointRevertRequestedPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.reverted"),
    payload: ThreadRevertedPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.session-stop-requested"),
    payload: ThreadSessionStopRequestedPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.session-set"),
    payload: ThreadSessionSetPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.proposed-plan-upserted"),
    payload: ThreadProposedPlanUpsertedPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.turn-diff-completed"),
    payload: ThreadTurnDiffCompletedPayload,
  }),
  z.looseObject({
    ...EventBaseFields,
    type: z.literal("thread.activity-appended"),
    payload: ThreadActivityAppendedPayload,
  }),
]);
export type OrchestrationEvent = z.infer<typeof OrchestrationEvent>;

export * from "./commands/event-payloads.js";

export const OrchestrationEventType = forwardCompatibleLiteral([
  "project.created",
  "project.meta-updated",
  "project.deleted",
  "thread.created",
  "thread.deleted",
  "thread.archived",
  "thread.unarchived",
  "thread.settled",
  "thread.unsettled",
  "thread.snoozed",
  "thread.unsnoozed",
  "thread.pinned",
  "thread.unpinned",
  "thread.pin-reordered",
  "thread.meta-updated",
  "thread.pull-request-linked",
  "thread.pull-request-unlinked",
  "thread.pull-request-synced",
  "thread.runtime-mode-set",
  "thread.interaction-mode-set",
  "thread.message-sent",
  "thread.turn-start-requested",
  "thread.turn-interrupt-requested",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.checkpoint-revert-requested",
  "thread.reverted",
  "thread.session-stop-requested",
  "thread.session-set",
  "thread.proposed-plan-upserted",
  "thread.turn-diff-completed",
  "thread.activity-appended",
]);
export type OrchestrationEventType = z.infer<typeof OrchestrationEventType>;
