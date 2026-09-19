// ---
// relationships:
//   implements:
//     - github-client
//     - github-binding-and-intake
//     - node-types
// ---
export { github, type GitHub, type GitHubOptions } from "./github.js";
export type { Auth } from "./auth.js";
export type { Transport, RestResponse, GraphqlOperation } from "./transport/transport.js";
export {
  GitHubError,
  NotFoundError,
  AmbiguousError,
  ValidationError,
  RateLimitError,
  SchemaMismatchError,
  ResponseShapeError,
  type ErrorCode,
  type SchemaGap,
} from "./transport/errors.js";
export { defineProject, defineIssueFields } from "./schema/define.js";
export type * from "./schema/types.js";
export type { EnsureChange } from "./schema/reconcile.js";
export type { Catalog, EnsureReport } from "./catalog/catalog.js";
export {
  nodeId,
  type NodeId,
  type ProjectId,
  type ItemId,
  type FieldId,
  type IsoDate,
  type RepoRef,
  type IssueRef,
} from "./refs.js";
export type { Owner, OwnerData, IssueFieldsCatalog } from "./owner/owner.js";
export type { IssueType, IssueTypeSpec } from "./owner/issue-types.js";
export type { IssueField, IssueFieldOption, IssueFieldSpec } from "./owner/issue-fields.js";
export type { Repo, RepoData } from "./repo/repo.js";
export type { Label, LabelSpec } from "./repo/labels.js";
export type { Milestone, MilestoneSpec } from "./repo/milestones.js";
export type { Conversation, CommentData, Reaction } from "./conversation/conversation.js";
export type { Comment } from "./conversation/comment.js";
export type {
  Issue,
  IssueData,
  IssuePatch,
  IssueFilter,
  CreateIssue,
  CloseIssue,
  Delta,
  IssueLike,
  PullLike,
} from "./issues/issue.js";
export type { IssueRelations } from "./issues/relations.js";
export type {
  Pull,
  PullData,
  PullPatch,
  PullFilter,
  CreatePull,
  ReviewInput,
  ThreadInput,
} from "./pulls/pull.js";
export type { Review, Thread, ThreadData } from "./pulls/review.js";
export type { ProjectLocator, ProjectSummary } from "./projects/locator.js";
export type { Project, ProjectData, ProjectPatch, ContentRef } from "./projects/project.js";
export type { Item, ItemData, DraftSpec } from "./projects/item.js";
export type {
  ProjectField,
  ProjectFieldSpec,
  ProjectFieldOption,
  ProjectIteration,
} from "./projects/fields.js";
export type {
  StatusUpdate,
  StatusUpdateData,
  StatusInput,
  ProjectStatus,
} from "./projects/status.js";
