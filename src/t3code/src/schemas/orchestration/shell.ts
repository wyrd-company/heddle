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
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  forwardCompatibleLiteral,
  taggedUnionWithUnknown,
} from "../common.js";
import { ThreadPullRequestLink } from "./commands/pull-request-model.js";
import {
  ModelSelection,
  ProjectFaviconPath,
  ProjectIconOverride,
  ProjectScript,
  ProviderInteractionMode,
  RuntimeMode,
} from "./model.js";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  OrchestrationLatestTurn,
  OrchestrationSession,
  RepositoryIdentity,
  ThreadEnvMode,
  ThreadLinkedPullRequest,
  ThreadTitleRegeneration,
  ThreadTitleState,
} from "./read-model.js";

export const OrchestrationProjectShell = z.looseObject({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: RepositoryIdentity.nullable().optional(),
  defaultModelSelection: ModelSelection.nullable(),
  defaultThreadEnvMode: ThreadEnvMode.nullable().optional(),
  autoPull: z.boolean().optional(),
  faviconPath: ProjectFaviconPath.nullable().optional(),
  projectIcon: ProjectIconOverride.nullable().optional(),
  scripts: z.array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProjectShell = z.infer<typeof OrchestrationProjectShell>;
export const OrchestrationThreadShell = z.looseObject({
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.default(DEFAULT_PROVIDER_INTERACTION_MODE),
  branch: TrimmedNonEmptyString.nullable(),
  worktreePath: TrimmedNonEmptyString.nullable(),
  linkedPullRequest: ThreadLinkedPullRequest.nullable().optional(),
  pullRequests: z.array(ThreadPullRequestLink).default([]),
  branchPullRequest: ThreadLinkedPullRequest.nullable().optional(),
  latestTurn: OrchestrationLatestTurn.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: IsoDateTime.nullable().default(null),
  settledOverride: forwardCompatibleLiteral(["settled", "active"]).nullable().default(null),
  settledAt: IsoDateTime.nullable().default(null),
  unsettledAt: IsoDateTime.nullable().optional(),
  snoozedUntil: IsoDateTime.nullable().optional(),
  snoozedAt: IsoDateTime.nullable().optional(),
  pinnedAt: IsoDateTime.nullable().optional(),
  pinOrderKey: TrimmedNonEmptyString.nullable().optional(),
  activeOrderKey: TrimmedNonEmptyString.nullable().optional(),
  titleRegeneration: ThreadTitleRegeneration.nullable().optional(),
  titleState: ThreadTitleState.nullable().optional(),
  session: OrchestrationSession.nullable(),
  latestUserMessageAt: IsoDateTime.nullable(),
  hasPendingApprovals: z.boolean(),
  hasPendingUserInput: z.boolean(),
  hasActionableProposedPlan: z.boolean(),
  backgroundLiveness: forwardCompatibleLiteral(["working", "monitoring"]).nullable().optional(),
  planProgress: z
    .looseObject({
      step: TrimmedNonEmptyString,
      completedSteps: NonNegativeInt,
      totalSteps: NonNegativeInt,
    })
    .nullable()
    .optional(),
});
export type OrchestrationThreadShell = z.infer<typeof OrchestrationThreadShell>;
export const OrchestrationShellSnapshot = z.looseObject({
  snapshotSequence: NonNegativeInt,
  projects: z.array(OrchestrationProjectShell),
  threads: z.array(OrchestrationThreadShell),
  updatedAt: IsoDateTime,
});
export type OrchestrationShellSnapshot = z.infer<typeof OrchestrationShellSnapshot>;
export const OrchestrationShellStreamItem = taggedUnionWithUnknown("kind", [
  z.looseObject({ kind: z.literal("synchronized") }),
  z.looseObject({ kind: z.literal("snapshot"), snapshot: OrchestrationShellSnapshot }),
  z.looseObject({
    kind: z.literal("project-upserted"),
    sequence: NonNegativeInt,
    project: OrchestrationProjectShell,
  }),
  z.looseObject({
    kind: z.literal("project-removed"),
    sequence: NonNegativeInt,
    projectId: ProjectId,
  }),
  z.looseObject({
    kind: z.literal("thread-upserted"),
    sequence: NonNegativeInt,
    thread: OrchestrationThreadShell,
  }),
  z.looseObject({
    kind: z.literal("thread-removed"),
    sequence: NonNegativeInt,
    threadId: ThreadId,
  }),
]);
export type OrchestrationShellStreamItem = z.infer<typeof OrchestrationShellStreamItem>;
export const OrchestrationSubscribeShellInput = z.looseObject({
  afterSequence: NonNegativeInt.optional(),
  requestCompletionMarker: z.boolean().optional(),
});
export type OrchestrationSubscribeShellInput = z.infer<typeof OrchestrationSubscribeShellInput>;
export const OrchestrationSubscribeThreadInput = z.looseObject({
  threadId: ThreadId,
  afterSequence: NonNegativeInt.optional(),
  requestCompletionMarker: z.boolean().optional(),
  turnLimit: PositiveInt.optional(),
});
export type OrchestrationSubscribeThreadInput = z.infer<typeof OrchestrationSubscribeThreadInput>;
