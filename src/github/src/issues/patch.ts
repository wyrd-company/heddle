import type {
  AddAssigneesToAssignableInput,
  AddLabelsToLabelableInput,
  IssueFieldCreateOrUpdateInput,
  RemoveAssigneesFromAssignableInput,
  RemoveLabelsFromLabelableInput,
  SetIssueFieldValueInput,
  UpdateIssueInput,
} from "../generated/graphql.js";
import type { NodeId } from "../refs.js";

export type Delta = string[] | { add?: string[]; remove?: string[] };

/** Everything the planner needs already resolved to ids. Resolution is the handle's job. */
export interface PatchInputs {
  issueId: NodeId;
  title?: string;
  body?: string;
  /** Present when the patch names a type; null clears. */
  issueTypeId?: NodeId | null;
  /** Present when the patch names a milestone; null clears. */
  milestoneId?: NodeId | null;
  labels?: { delta: Delta; current: readonly string[]; ids: ReadonlyMap<string, NodeId> };
  assignees?: { delta: Delta; current: readonly string[]; ids: ReadonlyMap<string, NodeId> };
  /** Encoded by field-values.ts, one per patched field, in patch order. */
  fields?: readonly IssueFieldCreateOrUpdateInput[];
}

export type IssueMutation =
  | { kind: "updateIssue"; input: UpdateIssueInput }
  | { kind: "removeLabels"; input: RemoveLabelsFromLabelableInput }
  | { kind: "addLabels"; input: AddLabelsToLabelableInput }
  | { kind: "removeAssignees"; input: RemoveAssigneesFromAssignableInput }
  | { kind: "addAssignees"; input: AddAssigneesToAssignableInput }
  | { kind: "setIssueFieldValue"; input: SetIssueFieldValueInput };

/** Splits a delta against the current set into names to remove and names to add. */
export function planDelta(
  delta: Delta,
  current: readonly string[],
): { remove: string[]; add: string[] } {
  const have = new Set(current);
  if (Array.isArray(delta)) {
    const want = new Set(delta);
    return {
      remove: current.filter((name) => !want.has(name)),
      add: delta.filter((name) => !have.has(name)),
    };
  }
  return {
    remove: (delta.remove ?? []).filter((name) => have.has(name)),
    add: (delta.add ?? []).filter((name) => !have.has(name)),
  };
}

function idsFor(names: readonly string[], ids: ReadonlyMap<string, NodeId>, what: string) {
  return names.map((name) => {
    const id = ids.get(name);
    if (id === undefined) throw new Error(`unresolved ${what}: ${name}`);
    return id;
  });
}

/**
 * PURE planner: updateIssue first, then label and assignee removals and
 * additions, then one setIssueFieldValue carrying every field write.
 */
export function planIssuePatch(inputs: PatchInputs): IssueMutation[] {
  const plan: IssueMutation[] = [];
  const update: UpdateIssueInput = { id: inputs.issueId };
  if (inputs.title !== undefined) update.title = inputs.title;
  if (inputs.body !== undefined) update.body = inputs.body;
  if (inputs.issueTypeId !== undefined) update.issueTypeId = inputs.issueTypeId;
  if (inputs.milestoneId !== undefined) update.milestoneId = inputs.milestoneId;
  if (Object.keys(update).length > 1) plan.push({ kind: "updateIssue", input: update });

  if (inputs.labels) {
    const { remove, add } = planDelta(inputs.labels.delta, inputs.labels.current);
    const ids = (names: string[]) => idsFor(names, inputs.labels!.ids, "label");
    if (remove.length > 0) {
      plan.push({
        kind: "removeLabels",
        input: { labelableId: inputs.issueId, labelIds: ids(remove) },
      });
    }
    if (add.length > 0) {
      plan.push({ kind: "addLabels", input: { labelableId: inputs.issueId, labelIds: ids(add) } });
    }
  }

  if (inputs.assignees) {
    const { remove, add } = planDelta(inputs.assignees.delta, inputs.assignees.current);
    const ids = (names: string[]) => idsFor(names, inputs.assignees!.ids, "assignee");
    if (remove.length > 0) {
      plan.push({
        kind: "removeAssignees",
        input: { assignableId: inputs.issueId, assigneeIds: ids(remove) },
      });
    }
    if (add.length > 0) {
      plan.push({
        kind: "addAssignees",
        input: { assignableId: inputs.issueId, assigneeIds: ids(add) },
      });
    }
  }

  if (inputs.fields && inputs.fields.length > 0) {
    plan.push({
      kind: "setIssueFieldValue",
      input: { issueId: inputs.issueId, issueFields: [...inputs.fields] },
    });
  }
  return plan;
}
