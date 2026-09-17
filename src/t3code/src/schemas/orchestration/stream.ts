// ---
// relationships:
//   implements:
//     - t3-code-client
//     - agent-tools
//     - node-types
// ---
import { z } from "zod";
import { TrimmedString } from "../common.js";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  forwardCompatibleLiteral,
  taggedUnionWithUnknown,
} from "../common.js";
import { OrchestrationEvent } from "./events.js";
import { OrchestrationThreadDetailSnapshot } from "./read-model.js";

export const OrchestrationThreadStreamItem = taggedUnionWithUnknown("kind", [
  z.looseObject({ kind: z.literal("synchronized") }),
  z.looseObject({ kind: z.literal("snapshot"), snapshot: OrchestrationThreadDetailSnapshot }),
  z.looseObject({ kind: z.literal("event"), event: OrchestrationEvent }),
]);
export type OrchestrationThreadStreamItem = z.infer<typeof OrchestrationThreadStreamItem>;
export const DispatchResult = z.looseObject({ sequence: NonNegativeInt });
export type DispatchResult = z.infer<typeof DispatchResult>;
export const TurnCountRange = z
  .looseObject({ fromTurnCount: NonNegativeInt, toTurnCount: NonNegativeInt })
  .refine(
    (v) => v.fromTurnCount <= v.toTurnCount,
    "fromTurnCount must be less than or equal to toTurnCount",
  );
export type TurnCountRange = z.infer<typeof TurnCountRange>;
export const OrchestrationGetTurnDiffInput = TurnCountRange.safeExtend({
  threadId: ThreadId,
  ignoreWhitespace: z.boolean().optional(),
});
export type OrchestrationGetTurnDiffInput = z.infer<typeof OrchestrationGetTurnDiffInput>;
export const ThreadTurnDiff = TurnCountRange.safeExtend({ threadId: ThreadId, diff: z.string() });
export type ThreadTurnDiff = z.infer<typeof ThreadTurnDiff>;
export const OrchestrationGetTurnDiffResult = ThreadTurnDiff;
export type OrchestrationGetTurnDiffResult = z.infer<typeof OrchestrationGetTurnDiffResult>;
export const OrchestrationGetFullThreadDiffInput = z.looseObject({
  threadId: ThreadId,
  toTurnCount: NonNegativeInt,
  ignoreWhitespace: z.boolean().optional(),
});
export type OrchestrationGetFullThreadDiffInput = z.infer<
  typeof OrchestrationGetFullThreadDiffInput
>;
export const OrchestrationGetFullThreadDiffResult = ThreadTurnDiff;
export type OrchestrationGetFullThreadDiffResult = z.infer<
  typeof OrchestrationGetFullThreadDiffResult
>;
export const OrchestrationSearchThreadsInput = z.looseObject({
  query: TrimmedString.min(2).max(200),
  limit: z.number().int().min(1).max(50).optional(),
});
export type OrchestrationSearchThreadsInput = z.infer<typeof OrchestrationSearchThreadsInput>;
export const OrchestrationThreadSearchSource = forwardCompatibleLiteral(["user", "assistant"]);
export type OrchestrationThreadSearchSource = z.infer<typeof OrchestrationThreadSearchSource>;
export const OrchestrationThreadSearchMatch = z.looseObject({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  snippet: z.string().max(240),
  messageCreatedAt: IsoDateTime.nullable(),
});
export type OrchestrationThreadSearchMatch = z.infer<typeof OrchestrationThreadSearchMatch>;
export const OrchestrationSearchThreadsResult = z.looseObject({
  matches: z.array(OrchestrationThreadSearchMatch),
});
export type OrchestrationSearchThreadsResult = z.infer<typeof OrchestrationSearchThreadsResult>;
export const OrchestrationGetWorkflowScriptInput = z.looseObject({
  threadId: ThreadId,
  scriptPath: TrimmedNonEmptyString,
});
export type OrchestrationGetWorkflowScriptInput = z.infer<
  typeof OrchestrationGetWorkflowScriptInput
>;
export const OrchestrationGetWorkflowScriptResult = z.looseObject({
  scriptPath: TrimmedNonEmptyString,
  contents: z.string(),
  truncated: z.boolean(),
});
export type OrchestrationGetWorkflowScriptResult = z.infer<
  typeof OrchestrationGetWorkflowScriptResult
>;
