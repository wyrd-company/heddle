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
  PositiveInt,
  TrimmedNonEmptyString,
  forwardCompatibleLiteral,
} from "../../common.js";

export const ThreadPullRequestKey = z.looseObject({
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type ThreadPullRequestKey = z.infer<typeof ThreadPullRequestKey>;
export const ThreadPullRequestLinkSource = forwardCompatibleLiteral([
  "manual",
  "created",
  "agent",
  "stack",
  "stack-dismissed",
]);
export type ThreadPullRequestLinkSource = z.infer<typeof ThreadPullRequestLinkSource>;
export const PullRequestActor = z.looseObject({
  login: TrimmedNonEmptyString,
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});
export type PullRequestActor = z.infer<typeof PullRequestActor>;
export const PullRequestChecksState = forwardCompatibleLiteral(["passing", "failing", "pending"]);
export type PullRequestChecksState = z.infer<typeof PullRequestChecksState>;
export const PullRequestMergeability = forwardCompatibleLiteral([
  "mergeable",
  "conflicting",
  "unknown",
]);
export type PullRequestMergeability = z.infer<typeof PullRequestMergeability>;
export const PullRequestReviewDecision = forwardCompatibleLiteral([
  "approved",
  "changes-requested",
  "review-required",
]);
export type PullRequestReviewDecision = z.infer<typeof PullRequestReviewDecision>;
export const PullRequestState = forwardCompatibleLiteral(["open", "closed", "merged"]);
export type PullRequestState = z.infer<typeof PullRequestState>;
export const ThreadPullRequestSnapshot = z.looseObject({
  state: PullRequestState,
  title: TrimmedNonEmptyString,
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  isDraft: z.boolean(),
  updatedAt: IsoDateTime.nullable(),
  syncedAt: IsoDateTime,
  closedAt: z.string().nullable().optional(),
  mergedAt: z.string().nullable().optional(),
  author: PullRequestActor.nullable().optional(),
  additions: NonNegativeInt.optional(),
  deletions: NonNegativeInt.optional(),
  changedFiles: NonNegativeInt.optional(),
  reviewDecision: PullRequestReviewDecision.nullable().optional(),
  checksState: PullRequestChecksState.nullable().optional(),
  mergeability: PullRequestMergeability.optional(),
});
export type ThreadPullRequestSnapshot = z.infer<typeof ThreadPullRequestSnapshot>;
export const ThreadPullRequestStackLayer = z.looseObject({
  number: PositiveInt,
  headBranch: TrimmedNonEmptyString,
  state: PullRequestState,
});
export type ThreadPullRequestStackLayer = z.infer<typeof ThreadPullRequestStackLayer>;
export const ThreadPullRequestStack = z.looseObject({
  kind: z.literal("native"),
  id: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
  base: TrimmedNonEmptyString,
  layers: z.array(ThreadPullRequestStackLayer),
});
export type ThreadPullRequestStack = z.infer<typeof ThreadPullRequestStack>;
export const ThreadPullRequestLink = z.looseObject({
  ...ThreadPullRequestKey.shape,
  url: TrimmedNonEmptyString,
  source: ThreadPullRequestLinkSource,
  linkedAt: IsoDateTime,
  snapshot: ThreadPullRequestSnapshot.nullable(),
  stack: ThreadPullRequestStack.nullable(),
});
export type ThreadPullRequestLink = z.infer<typeof ThreadPullRequestLink>;
