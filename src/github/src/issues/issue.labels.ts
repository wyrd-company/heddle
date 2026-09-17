// ---
// relationships:
//   implements: github-client
// ---
import type { IssueCoreFragment, IssueLabelFragment } from "../generated/graphql.js";
import type { Context } from "../context.js";
import type { Label } from "../repo/labels.js";
import { ResponseShapeError } from "../transport/errors.js";
import { collect, paginateFrom } from "../transport/paginate.js";
import { IssueLabelsPageDocument } from "./documents.js";
import { parseLabels } from "./parse.js";

function issueLabels(
  node: { __typename: string; labels?: IssueCoreFragment["labels"] } | null | undefined,
  path: string,
): NonNullable<IssueCoreFragment["labels"]> {
  if (node?.__typename !== "Issue" || !node.labels)
    throw new ResponseShapeError(path, "expected Issue labels");
  return node.labels;
}

/** Completes the issue's attached-label collection before exposing the snapshot. */
export async function loadIssueLabels(ctx: Context, issue: IssueCoreFragment): Promise<Label[]> {
  const nodes = await collect(
    paginateFrom<IssueLabelFragment>(
      issue.labels ?? { nodes: [], pageInfo: { hasNextPage: false } },
      async (after) => {
        const data = await ctx.execute(IssueLabelsPageDocument, {
          id: issue.id,
          first: ctx.labelPageSize,
          after,
        });
        return issueLabels(data.node, "IssueLabelsPage.node");
      },
    ),
  );
  return parseLabels(nodes);
}
