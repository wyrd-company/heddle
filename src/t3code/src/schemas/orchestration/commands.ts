// ---
// relationships:
//   implements:
//     - t3-code-client
//     - agent-tools
//     - node-types
// ---
import { z } from "zod";
import {
  ProjectCreateCommand,
  ProjectDeleteCommand,
  ProjectMetaUpdateCommand,
} from "./commands/project.js";
import {
  ThreadActiveReorderCommand,
  ThreadArchiveCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadInteractionModeSetCommand,
  ThreadMetaUpdateCommand,
  ThreadPinCommand,
  ThreadPinReorderCommand,
  ThreadPullRequestLinkCommand,
  ThreadPullRequestUnlinkCommand,
  ThreadRuntimeModeSetCommand,
  ThreadSettleCommand,
  ThreadSnoozeCommand,
  ThreadUnarchiveCommand,
  ThreadUnpinCommand,
  ThreadUnsettleCommand,
  ThreadUnsnoozeCommand,
} from "./commands/thread.js";
import {
  ClientThreadTurnStartCommand,
  ThreadApprovalRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadConversationRevertCommand,
  ThreadSessionStopCommand,
  ThreadTurnInterruptCommand,
  ThreadUserInputDismissCommand,
  ThreadUserInputRespondCommand,
} from "./commands/turn.js";

export const ClientOrchestrationCommand = z.union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadSettleCommand,
  ThreadUnsettleCommand,
  ThreadSnoozeCommand,
  ThreadUnsnoozeCommand,
  ThreadPinCommand,
  ThreadUnpinCommand,
  ThreadPinReorderCommand,
  ThreadActiveReorderCommand,
  ThreadMetaUpdateCommand,
  ThreadPullRequestLinkCommand,
  ThreadPullRequestUnlinkCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ClientThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadUserInputDismissCommand,
  ThreadCheckpointRevertCommand,
  ThreadConversationRevertCommand,
  ThreadSessionStopCommand,
]);
export type ClientOrchestrationCommand = z.infer<typeof ClientOrchestrationCommand>;

export * from "./commands/project.js";
export * from "./commands/thread.js";
export * from "./commands/turn.js";
export * from "./commands/attachments.js";
