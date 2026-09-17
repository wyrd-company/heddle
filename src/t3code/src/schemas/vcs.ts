// ---
// relationships:
//   implements:
//     - t3-code-client
//     - agent-tools
//     - node-types
// ---
import { z } from "zod";
import {
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  forwardCompatibleLiteral,
  taggedUnionWithUnknown,
} from "./common.js";

export const VcsStatusChangeRequestState = forwardCompatibleLiteral(["open", "closed", "merged"]);
export type VcsStatusChangeRequestState = z.infer<typeof VcsStatusChangeRequestState>;
export const VcsRef = z.looseObject({
  name: TrimmedNonEmptyString,
  isRemote: z.boolean().optional(),
  remoteName: TrimmedNonEmptyString.optional(),
  current: z.boolean(),
  isDefault: z.boolean(),
  worktreePath: TrimmedNonEmptyString.nullable(),
});
export type VcsRef = z.infer<typeof VcsRef>;
export const VcsWorktree = z.looseObject({
  path: TrimmedNonEmptyString,
  refName: TrimmedNonEmptyString,
});
export type VcsWorktree = z.infer<typeof VcsWorktree>;
export const VcsStatusInput = z.looseObject({ cwd: TrimmedNonEmptyString });
export type VcsStatusInput = z.infer<typeof VcsStatusInput>;
export const GIT_LIST_BRANCHES_MAX_LIMIT = 200;
export const VcsListRefsInput = z.looseObject({
  cwd: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.max(256).optional(),
  cursor: NonNegativeInt.optional(),
  includeMatchingRemoteRefs: z.boolean().optional(),
  refKind: z.enum(["all", "local", "remote"]).optional(),
  refresh: z.boolean().optional(),
  limit: PositiveInt.max(GIT_LIST_BRANCHES_MAX_LIMIT).optional(),
});
export type VcsListRefsInput = z.infer<typeof VcsListRefsInput>;
export const VcsCreateWorktreeInput = z.looseObject({
  cwd: TrimmedNonEmptyString,
  refName: TrimmedNonEmptyString,
  newRefName: TrimmedNonEmptyString.optional(),
  baseRefName: TrimmedNonEmptyString.optional(),
  path: TrimmedNonEmptyString.nullable(),
});
export type VcsCreateWorktreeInput = z.infer<typeof VcsCreateWorktreeInput>;
export const VcsRemoveWorktreeInput = z.looseObject({
  cwd: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  force: z.boolean().optional(),
});
export type VcsRemoveWorktreeInput = z.infer<typeof VcsRemoveWorktreeInput>;
export const VcsCreateRefInput = z.looseObject({
  cwd: TrimmedNonEmptyString,
  refName: TrimmedNonEmptyString,
  switchRef: z.boolean().optional(),
});
export type VcsCreateRefInput = z.infer<typeof VcsCreateRefInput>;
export const VcsCreateRefResult = z.looseObject({ refName: TrimmedNonEmptyString });
export type VcsCreateRefResult = z.infer<typeof VcsCreateRefResult>;
export const VcsSwitchRefInput = z.looseObject({
  cwd: TrimmedNonEmptyString,
  refName: TrimmedNonEmptyString,
});
export type VcsSwitchRefInput = z.infer<typeof VcsSwitchRefInput>;
export const VcsStatusChangeRequest = z.looseObject({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: z.string(),
  baseRef: TrimmedNonEmptyString,
  headRef: TrimmedNonEmptyString,
  state: VcsStatusChangeRequestState,
  isDraft: z.boolean().optional(),
  updatedAt: z.string().nullable().optional(),
});
export type VcsStatusChangeRequest = z.infer<typeof VcsStatusChangeRequest>;
export const SourceControlProviderKind = forwardCompatibleLiteral([
  "github",
  "gitlab",
  "forgejo",
  "azure-devops",
  "bitbucket",
  "unknown",
]);
export type SourceControlProviderKind = z.infer<typeof SourceControlProviderKind>;
export const SourceControlProviderInfo = z.looseObject({
  kind: SourceControlProviderKind,
  name: TrimmedNonEmptyString,
  baseUrl: z.string(),
});
export type SourceControlProviderInfo = z.infer<typeof SourceControlProviderInfo>;
export const VcsStatusLocalShape = {
  isRepo: z.boolean(),
  sourceControlProvider: SourceControlProviderInfo.optional(),
  hasPrimaryRemote: z.boolean(),
  isDefaultRef: z.boolean(),
  refName: TrimmedNonEmptyString.nullable(),
  hasWorkingTreeChanges: z.boolean(),
  workingTree: z.looseObject({
    files: z.array(
      z.looseObject({
        path: TrimmedNonEmptyString,
        insertions: NonNegativeInt,
        deletions: NonNegativeInt,
      }),
    ),
    insertions: NonNegativeInt,
    deletions: NonNegativeInt,
  }),
};
export const VcsStatusRemoteShape = {
  hasUpstream: z.boolean(),
  aheadCount: NonNegativeInt,
  behindCount: NonNegativeInt,
  aheadOfDefaultCount: NonNegativeInt.optional(),
  pr: VcsStatusChangeRequest.nullable(),
};
export const VcsStatusLocalResult = z.looseObject(VcsStatusLocalShape);
export type VcsStatusLocalResult = z.infer<typeof VcsStatusLocalResult>;
export const VcsStatusRemoteResult = z.looseObject(VcsStatusRemoteShape);
export type VcsStatusRemoteResult = z.infer<typeof VcsStatusRemoteResult>;
export const VcsStatusResult = z.looseObject({ ...VcsStatusLocalShape, ...VcsStatusRemoteShape });
export type VcsStatusResult = z.infer<typeof VcsStatusResult>;
export const VcsStatusStreamEvent = taggedUnionWithUnknown("_tag", [
  z.looseObject({
    _tag: z.literal("snapshot"),
    local: VcsStatusLocalResult,
    remote: VcsStatusRemoteResult.nullable(),
  }),
  z.looseObject({ _tag: z.literal("localUpdated"), local: VcsStatusLocalResult }),
  z.looseObject({ _tag: z.literal("remoteUpdated"), remote: VcsStatusRemoteResult.nullable() }),
]);
export type VcsStatusStreamEvent = z.infer<typeof VcsStatusStreamEvent>;
export const VcsListRefsResult = z.looseObject({
  refs: z.array(VcsRef),
  isRepo: z.boolean(),
  hasPrimaryRemote: z.boolean(),
  nextCursor: NonNegativeInt.nullable(),
  totalCount: NonNegativeInt,
});
export type VcsListRefsResult = z.infer<typeof VcsListRefsResult>;
export const VcsCreateWorktreeResult = z.looseObject({ worktree: VcsWorktree });
export type VcsCreateWorktreeResult = z.infer<typeof VcsCreateWorktreeResult>;
export const VcsSwitchRefResult = z.looseObject({ refName: TrimmedNonEmptyString.nullable() });
export type VcsSwitchRefResult = z.infer<typeof VcsSwitchRefResult>;
