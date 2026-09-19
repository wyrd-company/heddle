import type { Context } from "../context.js";
import type { RepoCoordinates } from "../refs.js";
import { NotFoundError, ResponseShapeError } from "../transport/errors.js";
import { paginate } from "../transport/paginate.js";
import type { CreatePull, Pull, PullData, PullFilter } from "./pull.js";
import { createPull } from "./pull.js";
import { CreatePullRequestDocument, ListPullRequestsDocument } from "./documents.js";
import { parsePullRequest, parseListedPullRequest, pullStateVariables } from "./parse.js";

export async function createPullInRepo(
  ctx: Context,
  repo: RepoCoordinates,
  input: CreatePull,
): Promise<Pull> {
  const { RepoLoadDocument } = await import("../repo/documents.js");
  const repoResult = await ctx.execute(RepoLoadDocument, { owner: repo.owner, name: repo.repo });
  const repoData = repoResult.repository;
  if (!repoData) throw new NotFoundError("repository", `${repo.owner}/${repo.repo}`);

  const result = await ctx.execute(CreatePullRequestDocument, {
    input: {
      repositoryId: repoData.id,
      baseRefName: input.base,
      headRefName: input.head,
      title: input.title,
      body: input.body || "",
      draft: input.draft || false,
      maintainerCanModify: input.maintainerCanModify || false,
    },
  });
  const pr = result.createPullRequest?.pullRequest;
  if (!pr) throw new ResponseShapeError("createPull", "missing pullRequest");
  const data = parsePullRequest(pr);
  return createPull(ctx, {
    coords: { owner: repo.owner, repo: repo.repo, number: data.number },
    id: data.id,
  });
}

export function listPulls(
  ctx: Context,
  repo: RepoCoordinates,
  filter: PullFilter | undefined,
): AsyncIterable<PullData> {
  return paginate(async (after) => {
    const states = filter?.state ? [...pullStateVariables[filter.state]] : undefined;
    const result = await ctx.execute(ListPullRequestsDocument, {
      owner: repo.owner,
      repo: repo.repo,
      after,
      state: states,
    });
    const connection = result.repository?.pullRequests;
    if (!connection) throw new ResponseShapeError("listPulls", "missing pullRequests");
    const nodes = (connection.nodes || [])
      .filter((n: unknown) => n !== null)
      .map(parseListedPullRequest);
    return { nodes, pageInfo: connection.pageInfo || { hasNextPage: false } };
  });
}
