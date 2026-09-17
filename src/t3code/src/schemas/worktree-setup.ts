// ---
// relationships:
//   implements:
//     - t3-code-client
//     - agent-tools
//     - node-types
// ---
import { z } from "zod";
import {
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
  forwardCompatibleLiteral,
} from "./common.js";

export const WorktreeSetupStageId = forwardCompatibleLiteral([
  "fetch",
  "checkout",
  "submodules",
  "setup-script",
  "agent",
]);
export type WorktreeSetupStageId = z.infer<typeof WorktreeSetupStageId>;
export const WorktreeSetupStageStatus = forwardCompatibleLiteral([
  "pending",
  "running",
  "done",
  "skipped",
  "warning",
  "failed",
]);
export type WorktreeSetupStageStatus = z.infer<typeof WorktreeSetupStageStatus>;
export const WORKTREE_SETUP_DETAIL_MAX_LENGTH = 200;
export const WORKTREE_SETUP_TAIL_LINE_MAX_LENGTH = 400;
export const WorktreeSetupStage = z.looseObject({
  id: WorktreeSetupStageId,
  status: WorktreeSetupStageStatus,
  startedAt: IsoDateTime.nullable(),
  endedAt: IsoDateTime.nullable(),
  percent: z.number().int().min(0).max(100).nullable(),
  detail: z.string().max(WORKTREE_SETUP_DETAIL_MAX_LENGTH).nullable(),
  tail: z.array(z.string().max(WORKTREE_SETUP_TAIL_LINE_MAX_LENGTH)),
});
export type WorktreeSetupStage = z.infer<typeof WorktreeSetupStage>;
export const WorktreeSetupPhase = forwardCompatibleLiteral([
  "running",
  "done",
  "failed",
  "cancelled",
]);
export type WorktreeSetupPhase = z.infer<typeof WorktreeSetupPhase>;
export const WORKTREE_SETUP_ERROR_MAX_LENGTH = 1000;
export const WorktreeSetupSnapshot = z.looseObject({
  threadId: ThreadId,
  phase: WorktreeSetupPhase,
  startedAt: IsoDateTime,
  endedAt: IsoDateTime.nullable(),
  branch: TrimmedNonEmptyString.nullable(),
  baseRef: TrimmedNonEmptyString.nullable(),
  worktreePath: TrimmedNonEmptyString.nullable(),
  setupScript: z
    .looseObject({
      name: TrimmedNonEmptyString,
      command: TrimmedNonEmptyString,
      terminalId: TrimmedNonEmptyString,
    })
    .nullable(),
  stages: z.array(WorktreeSetupStage),
  error: z.string().max(WORKTREE_SETUP_ERROR_MAX_LENGTH).nullable(),
  sequence: NonNegativeInt,
});
export type WorktreeSetupSnapshot = z.infer<typeof WorktreeSetupSnapshot>;
export const WorktreeSetupSubscribeInput = z.looseObject({ threadId: ThreadId });
export type WorktreeSetupSubscribeInput = z.infer<typeof WorktreeSetupSubscribeInput>;
export const WorktreeSetupStreamEvent = WorktreeSetupSnapshot.nullable();
export type WorktreeSetupStreamEvent = z.infer<typeof WorktreeSetupStreamEvent>;
export const WorktreeSetupCancelInput = z.looseObject({ threadId: ThreadId });
export type WorktreeSetupCancelInput = z.infer<typeof WorktreeSetupCancelInput>;
export const WorktreeSetupCancelResult = z.looseObject({ cancelled: z.boolean() });
export type WorktreeSetupCancelResult = z.infer<typeof WorktreeSetupCancelResult>;
