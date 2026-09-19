import type { Context } from "../context.js";
import {
  AddAssigneesToAssignableDocument,
  AddLabelsToLabelableDocument,
  RemoveAssigneesFromAssignableDocument,
  RemoveLabelsFromLabelableDocument,
  SetIssueFieldValueDocument,
  UpdateIssueDocument,
} from "./documents.js";
import type { Delta, IssueMutation } from "./patch.js";

/** Every name a delta mentions, for id resolution. */
export function deltaNames(delta: Delta): string[] {
  return Array.isArray(delta) ? delta : [...(delta.add ?? []), ...(delta.remove ?? [])];
}

/** Runs one planned issue mutation through the transport. */
export function runIssueMutation(ctx: Context, mutation: IssueMutation): Promise<unknown> {
  switch (mutation.kind) {
    case "updateIssue":
      return ctx.execute(UpdateIssueDocument, { input: mutation.input });
    case "removeLabels":
      return ctx.execute(RemoveLabelsFromLabelableDocument, { input: mutation.input });
    case "addLabels":
      return ctx.execute(AddLabelsToLabelableDocument, { input: mutation.input });
    case "removeAssignees":
      return ctx.execute(RemoveAssigneesFromAssignableDocument, { input: mutation.input });
    case "addAssignees":
      return ctx.execute(AddAssigneesToAssignableDocument, { input: mutation.input });
    case "setIssueFieldValue":
      return ctx.execute(SetIssueFieldValueDocument, { input: mutation.input });
  }
}
