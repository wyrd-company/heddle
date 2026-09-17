import type { Context } from "../context.js";
import { nodeId, parseIssueRef, scopes, type IssueRef, type NodeId } from "../refs.js";
import { NotFoundError } from "../transport/errors.js";
import { IssueIdDocument } from "./documents.js";
import type { IssueLike, PullLike } from "./issue.js";

function isHandle(value: unknown): value is { id(): Promise<NodeId> } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "function"
  );
}

/** Node id of an issue or pull request from a handle, a ref, or a node id. */
export async function resolveContentId(ctx: Context, like: IssueLike | PullLike): Promise<NodeId> {
  if (isHandle(like)) return like.id();
  if (typeof like === "string" && !like.includes("#")) return like as NodeId;
  return issueIdByRef(ctx, like as IssueRef);
}

/** Node id of an issue or pull request by coordinates, cached per repository. */
export function issueIdByRef(ctx: Context, ref: IssueRef): Promise<NodeId> {
  const coords = parseIssueRef(ref);
  return ctx.cache.remember(scopes.issues(coords), String(coords.number), async () => {
    const data = await ctx.execute(IssueIdDocument, coords);
    const found = data.repository?.issueOrPullRequest;
    if (!found) {
      throw new NotFoundError("issue", `${coords.owner}/${coords.repo}#${coords.number}`);
    }
    return nodeId(found.id);
  });
}

export function resolveAll(
  ctx: Context,
  likes: readonly (IssueLike | PullLike)[],
): Promise<NodeId[]> {
  return Promise.all(likes.map((like) => resolveContentId(ctx, like)));
}
