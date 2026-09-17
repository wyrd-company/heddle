// ---
// relationships:
//   implements:
//     - t3-code-client
//     - agent-tools
//     - node-types
// ---
import { OrchestrationMessageContext } from "./commands/message-context.js";
import { z } from "zod";
import {
  CheckpointRef,
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
  forwardCompatibleLiteral,
} from "../common.js";
import { ThreadPullRequestLink } from "./commands/pull-request-model.js";
import {
  ChatAttachment,
  ModelSelection,
  ProjectFaviconPath,
  ProjectIconOverride,
  ProjectScript,
  ProviderInteractionMode,
  RuntimeMode,
} from "./model.js";

export const RepositoryIdentityLocator = z.looseObject({
  source: z.literal("git-remote"),
  remoteName: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
});
export type RepositoryIdentityLocator = z.infer<typeof RepositoryIdentityLocator>;
export const RepositoryIdentity = z.looseObject({
  canonicalKey: TrimmedNonEmptyString,
  locator: RepositoryIdentityLocator,
  webUrl: TrimmedNonEmptyString.optional(),
  rootPath: TrimmedNonEmptyString.optional(),
  displayName: TrimmedNonEmptyString.optional(),
  provider: TrimmedNonEmptyString.optional(),
  owner: TrimmedNonEmptyString.optional(),
  name: TrimmedNonEmptyString.optional(),
});
export type RepositoryIdentity = z.infer<typeof RepositoryIdentity>;
export const ThreadEnvMode = forwardCompatibleLiteral(["local", "worktree"]);
export type ThreadEnvMode = z.infer<typeof ThreadEnvMode>;
export const OrchestrationProject = z.looseObject({
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
  deletedAt: IsoDateTime.nullable(),
});
export type OrchestrationProject = z.infer<typeof OrchestrationProject>;
export const DEFAULT_PROVIDER_INTERACTION_MODE = "default";
export const OrchestrationCheckpointFile = z.looseObject({
  path: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type OrchestrationCheckpointFile = z.infer<typeof OrchestrationCheckpointFile>;
export const OrchestrationCheckpointStatus = forwardCompatibleLiteral([
  "ready",
  "missing",
  "error",
]);
export type OrchestrationCheckpointStatus = z.infer<typeof OrchestrationCheckpointStatus>;
export const OrchestrationCheckpointSummary = z.looseObject({
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: z.array(OrchestrationCheckpointFile),
  assistantMessageId: MessageId.nullable(),
  completedAt: IsoDateTime,
});
export type OrchestrationCheckpointSummary = z.infer<typeof OrchestrationCheckpointSummary>;
export const OrchestrationLatestTurnState = forwardCompatibleLiteral([
  "running",
  "interrupted",
  "completed",
  "error",
]);
export type OrchestrationLatestTurnState = z.infer<typeof OrchestrationLatestTurnState>;
export const OrchestrationProposedPlanId = TrimmedNonEmptyString;
export type OrchestrationProposedPlanId = z.infer<typeof OrchestrationProposedPlanId>;
export const SourceProposedPlanReference = z.looseObject({
  threadId: ThreadId,
  planId: OrchestrationProposedPlanId,
});
export type SourceProposedPlanReference = z.infer<typeof SourceProposedPlanReference>;
export const OrchestrationLatestTurn = z.looseObject({
  turnId: TurnId,
  state: OrchestrationLatestTurnState,
  requestedAt: IsoDateTime,
  startedAt: IsoDateTime.nullable(),
  completedAt: IsoDateTime.nullable(),
  assistantMessageId: MessageId.nullable(),
  sourceProposedPlan: SourceProposedPlanReference.optional(),
});
export type OrchestrationLatestTurn = z.infer<typeof OrchestrationLatestTurn>;

export const OrchestrationMessageRole = forwardCompatibleLiteral(["user", "assistant", "system"]);
export type OrchestrationMessageRole = z.infer<typeof OrchestrationMessageRole>;
export const OrchestrationMessage = z.looseObject({
  id: MessageId,
  role: OrchestrationMessageRole,
  text: z.string(),
  attachments: z.array(ChatAttachment).optional(),
  context: OrchestrationMessageContext.optional(),
  turnId: TurnId.nullable(),
  streaming: z.boolean(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationMessage = z.infer<typeof OrchestrationMessage>;
export const OrchestrationProposedPlan = z.looseObject({
  id: OrchestrationProposedPlanId,
  turnId: TurnId.nullable(),
  planMarkdown: TrimmedNonEmptyString,
  implementedAt: IsoDateTime.nullable().default(null),
  implementationThreadId: ThreadId.nullable().default(null),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProposedPlan = z.infer<typeof OrchestrationProposedPlan>;
export const DEFAULT_RUNTIME_MODE = "full-access";
export const OrchestrationSessionStatus = forwardCompatibleLiteral([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);
export type OrchestrationSessionStatus = z.infer<typeof OrchestrationSessionStatus>;
export const OrchestrationSession = z.looseObject({
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  providerName: TrimmedNonEmptyString.nullable(),
  providerInstanceId: ProviderInstanceId.optional(),
  runtimeMode: RuntimeMode.default(DEFAULT_RUNTIME_MODE),
  activeTurnId: TurnId.nullable(),
  lastError: TrimmedNonEmptyString.nullable(),
  updatedAt: IsoDateTime,
});
export type OrchestrationSession = z.infer<typeof OrchestrationSession>;
export const OrchestrationThreadActivityTone = forwardCompatibleLiteral([
  "info",
  "tool",
  "approval",
  "error",
]);
export type OrchestrationThreadActivityTone = z.infer<typeof OrchestrationThreadActivityTone>;
export const OrchestrationThreadActivity = z.looseObject({
  id: EventId,
  tone: OrchestrationThreadActivityTone,
  kind: forwardCompatibleLiteral([
    "approval.requested",
    "approval.resolved",
    "user-input.requested",
    "user-input.resolved",
    "provider.approval.respond.failed",
    "provider.user-input.respond.failed",
  ]),
  summary: TrimmedNonEmptyString,
  payload: z.unknown(),
  turnId: TurnId.nullable(),
  sequence: NonNegativeInt.optional(),
  createdAt: IsoDateTime,
});
export type OrchestrationThreadActivity = z.infer<typeof OrchestrationThreadActivity>;
export const ThreadLinkedPullRequest = z.looseObject({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
});
export type ThreadLinkedPullRequest = z.infer<typeof ThreadLinkedPullRequest>;
export const base = { version: 1, contextId: "ctx_1" };
export const ThreadTitleRegeneration = z.looseObject({
  requestId: CommandId,
  startedAt: IsoDateTime,
});
export type ThreadTitleRegeneration = z.infer<typeof ThreadTitleRegeneration>;
export const ThreadTitleState = z.looseObject({
  source: forwardCompatibleLiteral(["manual", "generated"]),
  version: CommandId,
  needsRefinement: z.boolean(),
});
export type ThreadTitleState = z.infer<typeof ThreadTitleState>;
export const OrchestrationThread = z.looseObject({
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
  deletedAt: IsoDateTime.nullable(),
  messages: z.array(OrchestrationMessage),
  proposedPlans: z.array(OrchestrationProposedPlan).default([]),
  activities: z.array(OrchestrationThreadActivity),
  checkpoints: z.array(OrchestrationCheckpointSummary),
  session: OrchestrationSession.nullable(),
});
export type OrchestrationThread = z.infer<typeof OrchestrationThread>;
export const OrchestrationReadModel = z.looseObject({
  snapshotSequence: NonNegativeInt,
  projects: z.array(OrchestrationProject),
  threads: z.array(OrchestrationThread),
  updatedAt: IsoDateTime,
});
export type OrchestrationReadModel = z.infer<typeof OrchestrationReadModel>;
export const OrchestrationThreadDetailPage = z.looseObject({
  beforeCursor: TrimmedNonEmptyString.nullable(),
  hasMore: z.boolean(),
  snapshotSequence: NonNegativeInt,
  threadSequence: NonNegativeInt.optional(),
});
export type OrchestrationThreadDetailPage = z.infer<typeof OrchestrationThreadDetailPage>;
export const OrchestrationThreadDetailSnapshot = z.looseObject({
  snapshotSequence: NonNegativeInt,
  thread: OrchestrationThread,
  page: OrchestrationThreadDetailPage.optional(),
});
export type OrchestrationThreadDetailSnapshot = z.infer<typeof OrchestrationThreadDetailSnapshot>;

export { OrchestrationMessageContext } from "./commands/message-context.js";

export const OrchestrationThreadDetailWindow = z.looseObject({
  turnLimit: PositiveInt.optional(),
  beforeCursor: TrimmedNonEmptyString.optional(),
});
export type OrchestrationThreadDetailWindow = z.infer<typeof OrchestrationThreadDetailWindow>;
