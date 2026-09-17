import type {
  AddBlockedByInput,
  AddCloseIssueReferencesInput,
  AddSubIssueInput,
  RemoveBlockedByInput,
  RemoveCloseIssueReferencesInput,
  RemoveSubIssueInput,
} from "../generated/graphql.js";
import type { NodeId } from "../refs.js";
import type { IssueLike, PullLike } from "./issue.js";

export interface IssueRelations {
  /** link sets this issue's parent; unlink with any value removes it. */
  parent?: IssueLike | null;
  /** Children of this issue. */
  subIssues?: IssueLike[];
  /** Issues that block this issue. */
  blockedBy?: IssueLike[];
  /** Development links: pull requests that close this issue. */
  closedBy?: PullLike[];
}

/** IssueRelations with every reference resolved to a node id. */
export interface ResolvedRelations {
  parent?: NodeId | null;
  subIssues?: NodeId[];
  blockedBy?: NodeId[];
  closedBy?: NodeId[];
}

export type RelationMutation =
  | { kind: "addSubIssue"; input: AddSubIssueInput }
  | { kind: "removeSubIssue"; input: RemoveSubIssueInput }
  | { kind: "addBlockedBy"; input: AddBlockedByInput }
  | { kind: "removeBlockedBy"; input: RemoveBlockedByInput }
  | { kind: "addCloseIssueReferences"; input: AddCloseIssueReferencesInput }
  | { kind: "removeCloseIssueReferences"; input: RemoveCloseIssueReferencesInput };

/**
 * PURE fan-out from resolved relations to mutations. `currentParent` is the
 * issue's parent today, needed to clear or unlink it.
 */
export function planRelations(
  issueId: NodeId,
  currentParent: NodeId | null,
  rel: ResolvedRelations,
  mode: "link" | "unlink",
): RelationMutation[] {
  const plan: RelationMutation[] = [];
  const linking = mode === "link";

  if (rel.parent !== undefined) {
    if (linking && rel.parent !== null) {
      plan.push({
        kind: "addSubIssue",
        input: { issueId: rel.parent, subIssueId: issueId, replaceParent: true },
      });
    } else if (currentParent !== null) {
      plan.push({ kind: "removeSubIssue", input: { issueId: currentParent, subIssueId: issueId } });
    }
  }

  for (const child of rel.subIssues ?? []) {
    plan.push(
      linking
        ? { kind: "addSubIssue", input: { issueId, subIssueId: child } }
        : { kind: "removeSubIssue", input: { issueId, subIssueId: child } },
    );
  }

  for (const blocker of rel.blockedBy ?? []) {
    plan.push(
      linking
        ? { kind: "addBlockedBy", input: { issueId, blockingIssueId: blocker } }
        : { kind: "removeBlockedBy", input: { issueId, blockingIssueId: blocker } },
    );
  }

  if (rel.closedBy && rel.closedBy.length > 0) {
    plan.push(
      linking
        ? { kind: "addCloseIssueReferences", input: { issueId, pullRequestIds: rel.closedBy } }
        : { kind: "removeCloseIssueReferences", input: { issueId, pullRequestIds: rel.closedBy } },
    );
  }
  return plan;
}
