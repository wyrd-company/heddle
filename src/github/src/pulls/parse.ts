import { ResponseShapeError } from "../transport/errors.js";
import { nodeId } from "../refs.js";
import type { Label } from "../repo/labels.js";
import type {
  PullCoreFragment,
  PullRequestState,
  ReviewThreadCoreFragment,
} from "../generated/graphql.js";
import type { PullData } from "./pull.js";
import type { ThreadData } from "./review.js";

export function parsePullRequest(node: PullCoreFragment | null | undefined): PullData {
  if (!node) {
    throw new ResponseShapeError("pull.pullRequest", "missing pullRequest");
  }
  if (node.__typename !== "PullRequest") {
    throw new ResponseShapeError("pull", `expected PullRequest, got ${node.__typename}`);
  }

  const labels: Label[] = [];
  if (node.labels?.nodes) {
    for (const l of node.labels.nodes) {
      if (l !== null) {
        labels.push({ id: nodeId(l.id), name: l.name, color: l.color, description: l.description });
      }
    }
  }

  const milestone = node.milestone ? { title: node.milestone.title } : null;

  const assignees: string[] = [];
  if (node.assignees?.nodes) {
    for (const a of node.assignees.nodes) {
      if (a !== null) {
        assignees.push(a.login);
      }
    }
  }

  const requestedReviewers = { users: [] as string[], teams: [] as string[] };
  for (const req of node.reviewRequests?.nodes ?? []) {
    if (!req) continue;
    const requester = req.requestedReviewer;
    if (!requester) continue;
    if (requester.__typename === "User") {
      requestedReviewers.users.push(requester.login);
    } else if (requester.__typename === "Team") {
      requestedReviewers.teams.push(requester.slug);
    }
  }

  const closes: `${string}/${string}#${number}`[] = [];
  if (node.closingIssuesReferences?.nodes) {
    for (const i of node.closingIssuesReferences.nodes) {
      if (i !== null) {
        const owner = i.repository.owner;
        const ownerLogin =
          "__typename" in owner && owner.__typename === "Bot"
            ? "bot"
            : "login" in owner
              ? owner.login
              : "unknown";
        closes.push(`${ownerLogin}/${i.repository.name}#${i.number}`);
      }
    }
  }

  const repoOwner = node.repository.owner;
  const repoOwnerLogin =
    "__typename" in repoOwner && repoOwner.__typename === "Bot"
      ? "bot"
      : "login" in repoOwner
        ? repoOwner.login
        : "unknown";

  return {
    id: nodeId(node.id),
    ref: `${repoOwnerLogin}/${node.repository.name}#${node.number}`,
    number: node.number,
    title: node.title ?? "",
    body: node.body ?? "",
    state: node.state === "MERGED" ? "merged" : node.state === "CLOSED" ? "closed" : "open",
    isDraft: node.isDraft ?? false,
    head: node.headRefName ?? "",
    base: node.baseRefName ?? "",
    milestone,
    labels,
    assignees,
    reviewDecision: node.reviewDecision ?? null,
    requestedReviewers,
    closes,
    createdAt: node.createdAt ?? "",
    updatedAt: node.updatedAt ?? "",
    url: node.url ?? "",
  } satisfies PullData;
}

export function parseListedPullRequest(node: PullCoreFragment | null | undefined): PullData {
  if (!node || node.__typename !== "PullRequest") {
    throw new ResponseShapeError("pull", `expected PullRequest, got ${node?.__typename}`);
  }
  return parsePullRequest(node);
}

export function parseReviewThread(node: ReviewThreadCoreFragment | null | undefined): ThreadData {
  if (!node) {
    throw new ResponseShapeError("thread", "missing thread");
  }

  const comments: ThreadData["comments"] = [];
  if (node.comments?.nodes) {
    for (const c of node.comments.nodes) {
      if (c !== null) {
        const author = c.author;
        const authorLogin =
          author && "__typename" in author
            ? "login" in author
              ? author.login
              : null
            : (author?.login ?? null);
        comments.push({ id: nodeId(c.id), body: c.body, author: authorLogin });
      }
    }
  }

  return {
    id: nodeId(node.id),
    path: node.path ?? "",
    line: node.line ?? null,
    startLine: node.originalStartLine ?? null,
    diffSide: node.diffSide ?? "RIGHT",
    isResolved: node.isResolved ?? false,
    isOutdated: node.isOutdated ?? false,
    comments,
  } satisfies ThreadData;
}

/** Wire values for the `states` argument of the pull request connection. */
export const pullStateVariables = {
  open: ["OPEN"],
  closed: ["CLOSED"],
  merged: ["MERGED"],
} as const satisfies Record<"open" | "closed" | "merged", readonly PullRequestState[]>;
