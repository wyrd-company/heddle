import type { Context } from "../context.js";
import type { NodeId } from "../refs.js";
import { NotFoundError } from "../transport/errors.js";
import type { IssueClosedStateReason } from "../generated/graphql.js";
import {
  AddBlockedByDocument,
  AddCloseIssueReferencesDocument,
  AddSubIssueDocument,
  CloseIssueDocument,
  RemoveBlockedByDocument,
  RemoveCloseIssueReferencesDocument,
  RemoveSubIssueDocument,
  ReopenIssueDocument,
  ReprioritizeSubIssueDocument,
  UnmarkIssueAsDuplicateDocument,
} from "./documents.js";
import type { CloseIssue, IssueData, IssueLike } from "./issue.js";
import { resolveAll, resolveContentId } from "./issue.resolve.js";
import {
  planRelations,
  type IssueRelations,
  type RelationMutation,
  type ResolvedRelations,
} from "./relations.js";
import type { IssueFieldSchema } from "../schema/types.js";

/** What the action functions need from the handle. */
export interface IssueActor<S extends IssueFieldSchema> {
  id(): Promise<NodeId>;
  load(): Promise<IssueData<S>>;
}

const reasons: Record<NonNullable<CloseIssue["reason"]>, IssueClosedStateReason> = {
  completed: "COMPLETED",
  "not-planned": "NOT_PLANNED",
  duplicate: "DUPLICATE",
};

export async function closeIssue<S extends IssueFieldSchema>(
  ctx: Context,
  issue: IssueActor<S>,
  opts: CloseIssue = {},
): Promise<void> {
  const issueId = await issue.id();
  const stateReason = reasons[opts.reason ?? "completed"];
  const duplicateIssueId =
    opts.reason === "duplicate" ? await resolveContentId(ctx, opts.of) : undefined;
  await ctx.execute(CloseIssueDocument, {
    input: duplicateIssueId ? { issueId, stateReason, duplicateIssueId } : { issueId, stateReason },
  });
}

export async function reopenIssue<S extends IssueFieldSchema>(ctx: Context, issue: IssueActor<S>) {
  await ctx.execute(ReopenIssueDocument, { input: { issueId: await issue.id() } });
}

/** Needs the canonical issue, which only the loaded data knows. */
export async function unmarkDuplicate<S extends IssueFieldSchema>(
  ctx: Context,
  issue: IssueActor<S>,
): Promise<void> {
  const data = await issue.load();
  if (data.duplicateOf === null) throw new NotFoundError("duplicate-of relationship", data.ref);
  const canonicalId = await resolveContentId(ctx, data.duplicateOf);
  await ctx.execute(UnmarkIssueAsDuplicateDocument, {
    input: { duplicateId: data.id, canonicalId },
  });
}

export async function applyRelations<S extends IssueFieldSchema>(
  ctx: Context,
  issue: IssueActor<S>,
  rel: IssueRelations,
  mode: "link" | "unlink",
): Promise<void> {
  const issueId = await issue.id();
  const needsParent = rel.parent !== undefined;
  const currentParentRef = needsParent ? (await issue.load()).parent : null;
  const currentParent = currentParentRef ? await resolveContentId(ctx, currentParentRef) : null;
  const resolved: ResolvedRelations = {};
  if (rel.parent !== undefined) {
    resolved.parent = rel.parent === null ? null : await resolveContentId(ctx, rel.parent);
  }
  if (rel.subIssues) resolved.subIssues = await resolveAll(ctx, rel.subIssues);
  if (rel.blockedBy) resolved.blockedBy = await resolveAll(ctx, rel.blockedBy);
  if (rel.closedBy) resolved.closedBy = await resolveAll(ctx, rel.closedBy);
  for (const mutation of planRelations(issueId, currentParent, resolved, mode)) {
    await runRelation(ctx, mutation);
  }
}

function runRelation(ctx: Context, mutation: RelationMutation): Promise<unknown> {
  switch (mutation.kind) {
    case "addSubIssue":
      return ctx.execute(AddSubIssueDocument, { input: mutation.input });
    case "removeSubIssue":
      return ctx.execute(RemoveSubIssueDocument, { input: mutation.input });
    case "addBlockedBy":
      return ctx.execute(AddBlockedByDocument, { input: mutation.input });
    case "removeBlockedBy":
      return ctx.execute(RemoveBlockedByDocument, { input: mutation.input });
    case "addCloseIssueReferences":
      return ctx.execute(AddCloseIssueReferencesDocument, { input: mutation.input });
    case "removeCloseIssueReferences":
      return ctx.execute(RemoveCloseIssueReferencesDocument, { input: mutation.input });
  }
}

export async function moveSubIssue<S extends IssueFieldSchema>(
  ctx: Context,
  issue: IssueActor<S>,
  child: IssueLike,
  position: { after: IssueLike | null },
): Promise<void> {
  const issueId = await issue.id();
  const subIssueId = await resolveContentId(ctx, child);
  if (position.after !== null) {
    const afterId = await resolveContentId(ctx, position.after);
    await ctx.execute(ReprioritizeSubIssueDocument, { input: { issueId, subIssueId, afterId } });
    return;
  }
  // GitHub requires one anchor: moving first means "before the current first sibling".
  const current = await issue.load();
  for (const ref of current.subIssues) {
    const beforeId = await resolveContentId(ctx, ref);
    if (beforeId === subIssueId) continue;
    await ctx.execute(ReprioritizeSubIssueDocument, { input: { issueId, subIssueId, beforeId } });
    return;
  }
  // The child is already the only sub-issue.
}
