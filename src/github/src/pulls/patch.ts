import type {
  ConvertPullRequestToDraftInput,
  MarkPullRequestReadyForReviewInput,
  UpdatePullRequestInput,
} from "../generated/graphql.js";
import type { IssueMutation } from "../issues/patch.js";
import type { NodeId } from "../refs.js";
import type { PullPatch } from "./pull.js";

/** Ids and current state a pull patch needs; resolved by the handle before planning. */
export interface PullPatchInputs {
  pullId: NodeId;
  milestoneId?: NodeId | null;
  labelIds?: Map<string, NodeId>;
  assigneeIds?: Map<string, NodeId>;
  /** Current label names and assignee logins; needed when an array replaces. */
  current?: { labels: readonly string[]; assignees: readonly string[] };
}

export type PullMutation =
  | { kind: "updatePullRequest"; input: UpdatePullRequestInput }
  | { kind: "convertToDraft"; input: ConvertPullRequestToDraftInput }
  | { kind: "markReadyForReview"; input: MarkPullRequestReadyForReviewInput }
  | Extract<
      IssueMutation,
      { kind: "addLabels" | "removeLabels" | "addAssignees" | "removeAssignees" }
    >;

/**
 * PURE: PullPatch plus resolved ids to an ordered mutation plan.
 * updatePullRequest first, then the draft toggle, then label and assignee deltas.
 * An array replaces (computed against `current`); `{ add, remove }` changes.
 */
export function planPullPatch(patch: PullPatch, inputs: PullPatchInputs): PullMutation[] {
  const plan: PullMutation[] = [];
  const update: UpdatePullRequestInput = { pullRequestId: inputs.pullId };
  if (patch.title !== undefined) update.title = patch.title;
  if (patch.body !== undefined) update.body = patch.body;
  if (patch.base !== undefined) update.baseRefName = patch.base;
  if (patch.milestone !== undefined) {
    update.milestoneId = patch.milestone === null ? null : (inputs.milestoneId ?? null);
  }
  if (Object.keys(update).length > 1) plan.push({ kind: "updatePullRequest", input: update });

  if (patch.draft === true) {
    plan.push({ kind: "convertToDraft", input: { pullRequestId: inputs.pullId } });
  } else if (patch.draft === false) {
    plan.push({ kind: "markReadyForReview", input: { pullRequestId: inputs.pullId } });
  }

  if (patch.labels !== undefined) {
    const { add, remove } = delta(patch.labels, inputs.current?.labels ?? []);
    const ids = (names: string[]) => names.map((n) => required(inputs.labelIds, n));
    if (remove.length > 0) {
      plan.push({
        kind: "removeLabels",
        input: { labelableId: inputs.pullId, labelIds: ids(remove) },
      });
    }
    if (add.length > 0) {
      plan.push({ kind: "addLabels", input: { labelableId: inputs.pullId, labelIds: ids(add) } });
    }
  }

  if (patch.assignees !== undefined) {
    const { add, remove } = delta(patch.assignees, inputs.current?.assignees ?? []);
    const ids = (logins: string[]) => logins.map((l) => required(inputs.assigneeIds, l));
    if (remove.length > 0) {
      plan.push({
        kind: "removeAssignees",
        input: { assignableId: inputs.pullId, assigneeIds: ids(remove) },
      });
    }
    if (add.length > 0) {
      plan.push({
        kind: "addAssignees",
        input: { assignableId: inputs.pullId, assigneeIds: ids(add) },
      });
    }
  }
  return plan;
}

function delta(
  wanted: string[] | { add?: string[]; remove?: string[] },
  current: readonly string[],
): { add: string[]; remove: string[] } {
  if (Array.isArray(wanted)) {
    return {
      add: wanted.filter((n) => !current.includes(n)),
      remove: current.filter((n) => !wanted.includes(n)),
    };
  }
  return { add: wanted.add ?? [], remove: wanted.remove ?? [] };
}

function required(map: Map<string, NodeId> | undefined, name: string): NodeId {
  const id = map?.get(name);
  if (!id) throw new Error(`planPullPatch: no id resolved for "${name}"`);
  return id;
}
