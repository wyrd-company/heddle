// ---
// relationships:
//   implements: github-client
// ---
import type { IssueCoreFragment } from "../generated/graphql.js";
import type { Context } from "../context.js";
import { formatIssueRef } from "../refs.js";
import { ResponseShapeError } from "../transport/errors.js";
import { collect, paginateFrom, type Connection } from "../transport/paginate.js";
import {
  IssueBlockedByPageDocument,
  IssueBlockingPageDocument,
  IssueClosedByPageDocument,
  IssueSubIssuesPageDocument,
} from "./documents.js";

type Locator = { number: number; repository: { name: string; owner: { login: string } } };

function refs(nodes: readonly Locator[]): `${string}/${string}#${number}`[] {
  return nodes.map((node) =>
    formatIssueRef({
      owner: node.repository.owner.login,
      repo: node.repository.name,
      number: node.number,
    }),
  );
}

function issueNode<T extends { __typename: string } | null | undefined>(
  node: T,
  path: string,
): Extract<NonNullable<T>, { __typename: "Issue" }> {
  if (node?.__typename !== "Issue") throw new ResponseShapeError(path, "expected Issue");
  return node as Extract<NonNullable<T>, { __typename: "Issue" }>;
}

async function relationshipRefs<T extends Locator>(
  firstPage: Connection<T>,
  fetchPage: (after: string) => Promise<Connection<T>>,
): Promise<`${string}/${string}#${number}`[]> {
  return refs(await collect(paginateFrom(firstPage, fetchPage)));
}

const emptyPage = { nodes: [], pageInfo: { hasNextPage: false } } as const;

/** Completes every collection relationship before exposing one IssueData snapshot. */
export async function loadIssueRelationships(
  ctx: Context,
  issue: IssueCoreFragment,
): Promise<{
  subIssues: `${string}/${string}#${number}`[];
  blockedBy: `${string}/${string}#${number}`[];
  blocking: `${string}/${string}#${number}`[];
  closedBy: `${string}/${string}#${number}`[];
}> {
  const variables = (after: string) => ({ id: issue.id, first: ctx.relationshipPageSize, after });
  const [subIssues, blockedBy, blocking, closedBy] = await Promise.all([
    relationshipRefs(issue.subIssues, async (after) => {
      const data = await ctx.execute(IssueSubIssuesPageDocument, variables(after));
      return issueNode(data.node, "IssueSubIssuesPage.node").subIssues;
    }),
    relationshipRefs(issue.blockedBy, async (after) => {
      const data = await ctx.execute(IssueBlockedByPageDocument, variables(after));
      return issueNode(data.node, "IssueBlockedByPage.node").blockedBy;
    }),
    relationshipRefs(issue.blocking, async (after) => {
      const data = await ctx.execute(IssueBlockingPageDocument, variables(after));
      return issueNode(data.node, "IssueBlockingPage.node").blocking;
    }),
    relationshipRefs(issue.closedByPullRequestsReferences ?? emptyPage, async (after) => {
      const data = await ctx.execute(IssueClosedByPageDocument, variables(after));
      return (
        issueNode(data.node, "IssueClosedByPage.node").closedByPullRequestsReferences ?? emptyPage
      );
    }),
  ]);
  return { subIssues, blockedBy, blocking, closedBy };
}
