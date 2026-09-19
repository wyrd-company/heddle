import type { Context } from "../context.js";
import type { IssueLike } from "../issues/issue.js";
import { parseIssueRef, type IssueRef, type NodeId, nodeId, scopes } from "../refs.js";
import { NotFoundError } from "../transport/errors.js";
import { GetActorIdDocument, GetIssueIdDocument, GetTeamIdDocument } from "./documents.queries.js";
import type { GetActorIdQuery, GetIssueIdQuery, GetTeamIdQuery } from "../generated/graphql.js";

export async function resolveIssueLike(ctx: Context, issue: IssueLike): Promise<NodeId> {
  if (typeof issue === "string") {
    if (issue.startsWith("I_")) {
      return issue as NodeId;
    }
    const parsed = parseIssueRef(issue as IssueRef);
    const result = await ctx.execute(GetIssueIdDocument, {
      owner: parsed.owner,
      repo: parsed.repo,
      number: parsed.number,
    });
    const found = (result as GetIssueIdQuery).repository?.issue;
    if (!found) throw new NotFoundError("issue", issue);
    return nodeId(found.id);
  }
  const issueHandle = issue as { id(): Promise<NodeId> };
  return await issueHandle.id();
}

export async function resolveActor(ctx: Context, owner: string, login: string): Promise<NodeId> {
  const cached = ctx.cache.get<NodeId>(scopes.actors(owner), login);
  if (cached) return cached;
  const result = await ctx.execute(GetActorIdDocument, { login });
  const user = (result as GetActorIdQuery).user;
  if (!user) throw new NotFoundError("user", login);
  const id = nodeId(user.id);
  ctx.cache.set(scopes.actors(owner), login, id);
  return id;
}

export async function resolveTeam(ctx: Context, owner: string, slug: string): Promise<NodeId> {
  const result = await ctx.execute(GetTeamIdDocument, { org: owner, slug });
  const team = (result as GetTeamIdQuery).organization?.team;
  if (!team) throw new NotFoundError("team", slug);
  return nodeId(team.id);
}
