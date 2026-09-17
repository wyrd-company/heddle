import { diffProperties, type CatalogAdapter } from "../catalog/adapter.js";
import type { Context } from "../context.js";
import { paginateRest } from "../transport/paginate.js";
import type { IsoDate, NodeId, RepoCoordinates } from "../refs.js";
import { scopes } from "../refs.js";
import { codeForRestStatus, GitHubError } from "../transport/errors.js";
import { parseMilestone } from "./milestones.parse.js";

export interface Milestone {
  id: NodeId;
  number: number;
  /** The milestone title. */
  name: string;
  description: string | null;
  dueOn: IsoDate | null;
  state: "open" | "closed";
}

/** `name` is the milestone title. */
export interface MilestoneSpec {
  name: string;
  description?: string;
  dueOn?: IsoDate;
  state?: "open" | "closed";
}

export function createMilestonesAdapter(
  ctx: Context,
  repo: RepoCoordinates,
): CatalogAdapter<Milestone, MilestoneSpec> {
  const route = `GET /repos/{owner}/{repo}/milestones`;
  const one = `/repos/{owner}/{repo}/milestones/{milestone_number}`;
  // GitHub reads due_on in US Pacific time; noon UTC lands on the intended calendar date.
  const dueOn = (date: IsoDate | undefined) => (date ? `${date}T12:00:00Z` : undefined);

  return {
    resource: "milestone",
    scope: scopes.milestones(repo),
    keyOf: (value) => value.name,
    async *list() {
      for await (const item of paginateRest<{
        id: number;
        number: number;
        title: string;
        description: string | null;
        due_on: string | null;
        state: "open" | "closed";
      }>((page, perPage) =>
        ctx.transport
          .rest(route, {
            owner: repo.owner,
            repo: repo.repo,
            state: "all",
            page,
            per_page: perPage,
          })
          .then((res) => {
            if (res.status >= 400) {
              throw new GitHubError(
                codeForRestStatus(res.status),
                `${route} failed with ${res.status}`,
              );
            }
            const items = res.data as Array<{
              id: number;
              number: number;
              title: string;
              description: string | null;
              due_on: string | null;
              state: "open" | "closed";
            }>;
            return items;
          }),
      )) {
        yield parseMilestone(item);
      }
    },
    async create(spec) {
      const res = await ctx.transport.rest(`POST ${route.slice(4)}`, {
        owner: repo.owner,
        repo: repo.repo,
        title: spec.name,
        description: spec.description,
        due_on: dueOn(spec.dueOn),
        state: spec.state || "open",
      });
      if (res.status >= 400) {
        throw new GitHubError(
          codeForRestStatus(res.status),
          `POST ${route.slice(4)} failed with ${res.status}`,
        );
      }
      return parseMilestone(
        res.data as {
          id: number;
          number: number;
          title: string;
          description: string | null;
          due_on: string | null;
          state: "open" | "closed";
        },
      );
    },
    async update(existing, patch) {
      const res = await ctx.transport.rest(`PATCH ${one}`, {
        owner: repo.owner,
        repo: repo.repo,
        milestone_number: existing.number,
        title: patch.name,
        description: patch.description,
        due_on: dueOn(patch.dueOn),
        state: patch.state,
      });
      if (res.status >= 400) {
        throw new GitHubError(
          codeForRestStatus(res.status),
          `PATCH ${one} failed with ${res.status}`,
        );
      }
      return parseMilestone(
        res.data as {
          id: number;
          number: number;
          title: string;
          description: string | null;
          due_on: string | null;
          state: "open" | "closed";
        },
      );
    },
    async delete(existing) {
      const res = await ctx.transport.rest(`DELETE ${one}`, {
        owner: repo.owner,
        repo: repo.repo,
        milestone_number: existing.number,
      });
      if (res.status >= 400) {
        throw new GitHubError(
          codeForRestStatus(res.status),
          `DELETE ${one} failed with ${res.status}`,
        );
      }
    },
    diff: (spec, existing) => diffProperties(spec, existing, ["description", "dueOn", "state"]),
  };
}
