import type { Context } from "../context.js";
import type { CreateIssueInput, IssueState } from "../generated/graphql.js";
import { nodeId, scopes, type RepoCoordinates } from "../refs.js";
import { RepoLoadDocument } from "../repo/documents.js";
import type { IssueFieldSchema } from "../schema/types.js";
import { NotFoundError } from "../transport/errors.js";
import { required } from "../transport/execute.js";
import { paginate } from "../transport/paginate.js";
import { CreateIssueDocument, IssueListDocument } from "./documents.js";
import {
  createIssue,
  type CreateIssue,
  type Issue,
  type IssueData,
  type IssueFilter,
} from "./issue.js";
import { issueNames } from "./issue.names.js";
import { resolveContentId } from "./issue.resolve.js";
import { parseIssue } from "./parse.js";

async function repositoryId(ctx: Context, repo: RepoCoordinates) {
  return ctx.cache.remember(scopes.repos(), `${repo.owner}/${repo.repo}:id`, async () => {
    const data = await ctx.execute(RepoLoadDocument, { owner: repo.owner, name: repo.repo });
    if (!data.repository) throw new NotFoundError("repository", `${repo.owner}/${repo.repo}`);
    return nodeId(data.repository.id);
  });
}

export async function createIssueInRepo<S extends IssueFieldSchema>(
  ctx: Context,
  repo: RepoCoordinates,
  schema: S | undefined,
  input: CreateIssue<S>,
): Promise<Issue<S>> {
  const names = issueNames(ctx, repo);
  const variables: CreateIssueInput = {
    repositoryId: await repositoryId(ctx, repo),
    title: input.title,
  };
  if (input.body !== undefined) variables.body = input.body;
  if (input.type !== undefined) variables.issueTypeId = await names.issueTypeId(input.type);
  if (input.milestone !== undefined)
    variables.milestoneId = await names.milestoneId(input.milestone);
  if (input.labels) variables.labelIds = [...(await names.labelIds(input.labels)).values()];
  if (input.assignees) variables.assigneeIds = [...(await names.userIds(input.assignees)).values()];
  if (input.parent !== undefined)
    variables.parentIssueId = await resolveContentId(ctx, input.parent);
  if (input.fields) variables.issueFields = await names.fieldWrites(input.fields);

  const data = await ctx.execute(CreateIssueDocument, { input: variables });
  const created = required(data.createIssue?.issue, "createIssue.issue");
  return createIssue(ctx, {
    coords: { ...repo, number: created.number },
    schema,
    id: nodeId(created.id),
  });
}

const stateNames: Record<NonNullable<IssueFilter["state"]>, IssueState> = {
  open: "OPEN",
  closed: "CLOSED",
};

export function listIssues<S extends IssueFieldSchema>(
  ctx: Context,
  repo: RepoCoordinates,
  schema: S | undefined,
  filter: IssueFilter | undefined,
): AsyncIterable<IssueData<S>> {
  return paginate(async (after) => {
    const data = await ctx.execute(IssueListDocument, {
      owner: repo.owner,
      repo: repo.repo,
      states: filter?.state ? [stateNames[filter.state]] : null,
      after: after ?? null,
    });
    const issues = required(data.repository?.issues, "repository.issues");
    return {
      nodes: (issues.nodes ?? []).map((node) => (node ? parseIssue(node, schema) : null)),
      pageInfo: issues.pageInfo,
    };
  });
}
