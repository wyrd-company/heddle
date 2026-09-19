import type { Context } from "../context.js";
import type { Issue } from "../issues/issue.js";
import type { Repo } from "../repo/repo.js";
import type { Pull } from "../pulls/pull.js";
import {
  nodeId,
  parseIssueRef,
  parseRepoRef,
  scopes,
  type IssueRef,
  type NodeId,
  type RepoCoordinates,
  type RepoRef,
} from "../refs.js";
import { RepoLoadDocument } from "../repo/documents.js";
import type { IssueFieldSchema } from "../schema/types.js";
import { NotFoundError } from "../transport/errors.js";
import { IssueOrPullIdDocument } from "./item-documents.js";

type Handle = Issue<IssueFieldSchema> | Pull;

function isHandle(content: unknown): content is Handle {
  return (
    typeof content === "object" &&
    content !== null &&
    "id" in content &&
    typeof (content as Handle).id === "function"
  );
}

/** Node id of an issue or pull request given a handle, a ref, or a node id. */
export async function resolveContentId(
  ctx: Context,
  content: Handle | IssueRef | NodeId,
): Promise<NodeId> {
  if (isHandle(content)) return content.id();
  if (typeof content === "string" && !content.includes("#")) return content as NodeId;
  const coords = parseIssueRef(content as IssueRef);
  const key = `${coords.owner}/${coords.repo}#${coords.number}`;
  return ctx.cache.remember(scopes.issues(coords), String(coords.number), async () => {
    const data = await ctx.execute(IssueOrPullIdDocument, {
      owner: coords.owner,
      name: coords.repo,
      number: coords.number,
    });
    const found = data.repository?.issueOrPullRequest;
    if (!found) throw new NotFoundError("issue or pull request", key);
    return nodeId(found.id);
  });
}

/** Repository node id, cached with the repo handle's own table. */
export async function repositoryId(ctx: Context, coords: RepoCoordinates): Promise<NodeId> {
  const key = `${coords.owner}/${coords.repo}`;
  const cached = ctx.cache.get<{ id: NodeId }>(scopes.repos(), key);
  if (cached) return cached.id;
  const data = await ctx.execute(RepoLoadDocument, { owner: coords.owner, name: coords.repo });
  if (!data.repository) throw new NotFoundError("repository", key);
  return nodeId(data.repository.id);
}

/** Coordinates of a repo handle or a repo ref. */
export function repoCoords(repo: Repo<IssueFieldSchema> | RepoRef): RepoCoordinates {
  if (typeof repo === "object" && "coords" in repo) return repo.coords;
  return parseRepoRef(repo);
}
