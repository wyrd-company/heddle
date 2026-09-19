import type { Context } from "../context.js";
import type { NodeId } from "../refs.js";
import { nodeId, scopes } from "../refs.js";
import { NotFoundError } from "../transport/errors.js";
import { UserDocument, TeamIdDocument } from "../issues/documents.js";

type UserResponse = { user?: { id?: string } };
type TeamResponse = { organization?: { team?: { id?: string } } };

export async function resolveUserIds(ctx: Context, logins: readonly string[]): Promise<NodeId[]> {
  if (logins.length === 0) return [];

  const scope = scopes.actors("github");
  const results: NodeId[] = [];

  for (const login of logins) {
    const cached = ctx.cache.get<NodeId>(scope, login);
    if (cached) {
      results.push(cached);
    } else {
      try {
        const data = await ctx.execute(UserDocument, { login });
        const response = data as UserResponse;
        const id = response?.user?.id;
        if (!id) throw new NotFoundError("user", login);
        const resolved = nodeId(id);
        ctx.cache.set(scope, login, resolved);
        results.push(resolved);
      } catch (e) {
        if ((e as { code?: string })?.code === "NOT_FOUND") throw new NotFoundError("user", login);
        throw e;
      }
    }
  }

  return results;
}

export async function resolveTeamIds(
  ctx: Context,
  org: string,
  slugs: readonly string[],
): Promise<NodeId[]> {
  if (slugs.length === 0) return [];

  const scope = scopes.actors(org);
  const results: NodeId[] = [];

  for (const slug of slugs) {
    const cached = ctx.cache.get<NodeId>(scope, `team:${slug}`);
    if (cached) {
      results.push(cached);
    } else {
      const data = await ctx.execute(TeamIdDocument, { org, slug });
      const response = data as TeamResponse;
      const id = response?.organization?.team?.id;
      if (!id) throw new NotFoundError("team", slug);
      const resolved = nodeId(id);
      ctx.cache.set(scope, `team:${slug}`, resolved);
      results.push(resolved);
    }
  }

  return results;
}
