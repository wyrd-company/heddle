import { createCatalog, type Catalog } from "../catalog/catalog.js";
import type { Context } from "../context.js";
import {
  createIssue,
  createIssueInRepo,
  listIssues,
  type CreateIssue,
  type Issue,
  type IssueData,
  type IssueFilter,
} from "../issues/issue.js";
import type { Owner } from "../owner/owner.js";
import {
  createPull,
  createPullInRepo,
  listPulls,
  type CreatePull,
  type Pull,
  type PullData,
  type PullFilter,
} from "../pulls/pull.js";
import { nodeId, scopes, type NodeId, type RepoCoordinates } from "../refs.js";
import type { IssueFieldSchema } from "../schema/types.js";
import { NotFoundError } from "../transport/errors.js";
import { RepoLoadDocument } from "./documents.js";
import { createLabelsAdapter, type Label, type LabelSpec } from "./labels.js";
import { createMilestonesAdapter, type Milestone, type MilestoneSpec } from "./milestones.js";

export interface RepoData {
  id: NodeId;
  owner: string;
  name: string;
  nameWithOwner: `${string}/${string}`;
  isPrivate: boolean;
  defaultBranch: string | null;
}

export interface Repo<S extends IssueFieldSchema> {
  readonly owner: Owner<S>;
  readonly name: string;
  readonly coords: RepoCoordinates;
  labels: Catalog<Label, LabelSpec>;
  milestones: Catalog<Milestone, MilestoneSpec>;
  issues: {
    create(input: CreateIssue<S>): Promise<Issue<S>>;
    list(filter?: IssueFilter): AsyncIterable<IssueData<S>>;
  };
  pulls: {
    create(input: CreatePull): Promise<Pull>;
    list(filter?: PullFilter): AsyncIterable<PullData>;
  };
  issue(number: number): Issue<S>;
  pull(number: number): Pull;
  load(): Promise<RepoData>;
}

export function createRepo<S extends IssueFieldSchema>(
  ctx: Context,
  owner: Owner<S>,
  name: string,
): Repo<S> {
  const coords: RepoCoordinates = { owner: owner.login, repo: name };
  const schema = owner.issueFieldSchema;
  return {
    owner,
    name,
    coords,
    labels: createCatalog(ctx, createLabelsAdapter(ctx, coords)),
    milestones: createCatalog(ctx, createMilestonesAdapter(ctx, coords)),
    issues: {
      create: (input) => createIssueInRepo(ctx, coords, schema, input),
      list: (filter) => listIssues(ctx, coords, schema, filter),
    },
    pulls: {
      create: (input) => createPullInRepo(ctx, coords, input),
      list: (filter) => listPulls(ctx, coords, filter),
    },
    issue: (number) => createIssue(ctx, { coords: { ...coords, number }, schema }),
    pull: (number) => createPull(ctx, { coords: { ...coords, number } }),
    load: () =>
      ctx.cache.remember(scopes.repos(), `${coords.owner}/${coords.repo}`, async () => {
        const data = await ctx.execute(RepoLoadDocument, { owner: coords.owner, name });
        const found = data.repository;
        if (!found) throw new NotFoundError("repository", `${coords.owner}/${name}`);
        return {
          id: nodeId(found.id),
          owner: found.owner.login,
          name: found.name,
          nameWithOwner: found.nameWithOwner as `${string}/${string}`,
          isPrivate: found.isPrivate,
          defaultBranch: found.defaultBranchRef?.name ?? null,
        } satisfies RepoData;
      }),
  };
}
