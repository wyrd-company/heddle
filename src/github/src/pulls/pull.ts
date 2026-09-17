import type { Conversation } from "../conversation/conversation.js";
import { conversationMethods } from "../conversation/conversation.js";
import type { Context } from "../context.js";
import type { Delta, IssueLike } from "../issues/issue.js";
import type { IssueCoordinates, IssueRef, NodeId } from "../refs.js";
import { nodeId } from "../refs.js";
import type { Label } from "../repo/labels.js";
import { NotFoundError, ResponseShapeError } from "../transport/errors.js";
import { paginate } from "../transport/paginate.js";
import type { Review, Thread, ThreadData } from "./review.js";
import { createReview, createThread, submitPendingReview } from "./review.js";
import {
  PullLoadDocument,
  UpdatePullRequestDocument,
  ConvertPullRequestToDraftDocument,
  MarkPullRequestReadyForReviewDocument,
  ClosePullRequestDocument,
  ReopenPullRequestDocument,
  RequestReviewsDocument,
  AddPullRequestReviewDocument,
  AddPullRequestReviewThreadDocument,
  AddCloseIssueReferencesDocument,
  RemoveCloseIssueReferencesDocument,
  ListReviewThreadsDocument,
} from "./documents.js";
import { parsePullRequest, parseReviewThread } from "./parse.js";
import { planPullPatch, type PullMutation, type PullPatchInputs } from "./patch.js";
import { issueNames } from "../issues/issue.names.js";
import { deltaNames, runIssueMutation } from "../issues/issue.run.js";
import { resolveActor, resolveIssueLike, resolveTeam } from "./pull.resolve.js";
// Re-export creation functions from separate module
export { createPullInRepo, listPulls } from "./pull.create.js";

export interface Pull extends Conversation {
  readonly ref: IssueRef;
  set(patch: PullPatch): Promise<void>;
  close(): Promise<void>;
  reopen(): Promise<void>;
  link(rel: { closes: IssueLike[] }): Promise<void>;
  unlink(rel: { closes: IssueLike[] }): Promise<void>;
  requestReview(who: { users?: string[]; teams?: string[]; replace?: boolean }): Promise<void>;
  review(input: ReviewInput): Promise<Review>;
  thread(input: ThreadInput): Promise<Thread>;
  threads(): AsyncIterable<ThreadData>;
  load(): Promise<PullData>;
}

export interface PullPatch {
  title?: string;
  body?: string;
  base?: string;
  draft?: boolean;
  milestone?: string | null;
  labels?: Delta;
  assignees?: Delta;
}

export interface CreatePull {
  title: string;
  body?: string;
  head: string;
  base: string;
  draft?: boolean;
  maintainerCanModify?: boolean;
}

export interface PullFilter {
  state?: "open" | "closed" | "merged";
}

export interface ReviewInput {
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body?: string;
  threads?: ThreadInput[];
}

export interface ThreadInput {
  path: string;
  line: number;
  side?: "LEFT" | "RIGHT";
  startLine?: number;
  body: string;
}

export interface PullData {
  id: NodeId;
  ref: `${string}/${string}#${number}`;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  isDraft: boolean;
  head: string;
  base: string;
  milestone: { title: string } | null;
  labels: Label[];
  assignees: string[];
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  requestedReviewers: { users: string[]; teams: string[] };
  closes: `${string}/${string}#${number}`[];
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface PullHandleArgs {
  coords: IssueCoordinates;
  id?: NodeId;
}

export function createPull(ctx: Context, args: PullHandleArgs): Pull {
  const { coords } = args;
  let resolvedId = args.id;

  const resolveId = async (): Promise<NodeId> => {
    if (resolvedId) return resolvedId;
    await load();
    return resolvedId!;
  };
  const load = async () => {
    const result = await ctx.execute(PullLoadDocument, {
      owner: coords.owner,
      repo: coords.repo,
      number: coords.number,
    });
    const found = result.repository?.pullRequest;
    if (!found) {
      throw new NotFoundError("pull request", `${coords.owner}/${coords.repo}#${coords.number}`);
    }
    const data = parsePullRequest(found);
    resolvedId = data.id;
    return data;
  };
  const ref: IssueRef = `${coords.owner}/${coords.repo}#${coords.number}`;

  const pull: Pull = {
    ref,
    ...conversationMethods(ctx, resolveId),
    set: async (patch) => {
      const id = await resolveId();
      const names = issueNames(ctx, coords);
      const labelNames = patch.labels === undefined ? [] : deltaNames(patch.labels);
      const assigneeNames = patch.assignees === undefined ? [] : deltaNames(patch.assignees);
      const replaces = Array.isArray(patch.labels) || Array.isArray(patch.assignees);
      const current = replaces ? await load() : undefined;
      const inputs: PullPatchInputs = {
        pullId: id,
        ...(patch.milestone !== undefined
          ? { milestoneId: await names.milestoneId(patch.milestone) }
          : {}),
        ...(labelNames.length > 0 ? { labelIds: await names.labelIds(labelNames) } : {}),
        ...(assigneeNames.length > 0 ? { assigneeIds: await names.userIds(assigneeNames) } : {}),
        ...(current
          ? { current: { labels: current.labels.map((l) => l.name), assignees: current.assignees } }
          : {}),
      };
      for (const mutation of planPullPatch(patch, inputs)) await runPullMutation(ctx, mutation);
    },
    close: async () => {
      const id = await resolveId();
      await ctx.execute(ClosePullRequestDocument, { input: { pullRequestId: id } });
    },
    reopen: async () => {
      const id = await resolveId();
      await ctx.execute(ReopenPullRequestDocument, { input: { pullRequestId: id } });
    },
    link: async (rel) => {
      const prId = await resolveId();
      for (const issue of rel.closes) {
        const issueId = await resolveIssueLike(ctx, issue);
        await ctx.execute(AddCloseIssueReferencesDocument, {
          input: { issueId, pullRequestIds: [prId] },
        });
      }
    },
    unlink: async (rel) => {
      const prId = await resolveId();
      for (const issue of rel.closes) {
        const issueId = await resolveIssueLike(ctx, issue);
        await ctx.execute(RemoveCloseIssueReferencesDocument, {
          input: { issueId, pullRequestIds: [prId] },
        });
      }
    },
    requestReview: async (who) => {
      const id = await resolveId();
      const userIds: NodeId[] = [];
      for (const login of who.users || []) {
        userIds.push(await resolveActor(ctx, coords.owner, login));
      }
      const teamIds: NodeId[] = [];
      for (const slug of who.teams || []) {
        teamIds.push(await resolveTeam(ctx, coords.owner, slug));
      }
      await ctx.execute(RequestReviewsDocument, {
        input: {
          pullRequestId: id,
          userIds: userIds.length > 0 ? userIds : undefined,
          teamIds: teamIds.length > 0 ? teamIds : undefined,
          union: !who.replace,
        },
      });
    },
    review: async (input) => {
      const id = await resolveId();
      const result = await ctx.execute(AddPullRequestReviewDocument, {
        input: {
          pullRequestId: id,
          event: input.event,
          body: input.body,
          threads: input.threads?.map((t) => ({
            path: t.path,
            line: t.line,
            side: t.side || "RIGHT",
            startLine: t.startLine,
            body: t.body,
          })),
        },
      });
      const rev = result.addPullRequestReview?.pullRequestReview;
      if (!rev) throw new ResponseShapeError("review", "missing pullRequestReview");
      return createReview(ctx, nodeId(rev.id));
    },
    thread: async (input) => {
      const id = await resolveId();
      const result = await ctx.execute(AddPullRequestReviewThreadDocument, {
        input: {
          pullRequestId: id,
          path: input.path,
          line: input.line,
          side: input.side || "RIGHT",
          startLine: input.startLine,
          body: input.body,
        },
      });
      const t = result.addPullRequestReviewThread?.thread;
      if (!t) throw new ResponseShapeError("thread", "missing thread");
      await submitPendingReview(ctx, t.comments.nodes?.[0]?.pullRequestReview);
      return createThread(ctx, nodeId(t.id));
    },
    threads: () =>
      paginate(async (after) => {
        const id = await resolveId();
        const result = await ctx.execute(ListReviewThreadsDocument, { pullRequestId: id, after });
        const pr = result.node;
        if (!pr || !("reviewThreads" in pr)) {
          throw new ResponseShapeError("threads", "missing pull request");
        }
        const nodes = (pr.reviewThreads?.nodes ?? [])
          .filter((n) => n !== null)
          .map(parseReviewThread);
        return { nodes, pageInfo: pr.reviewThreads?.pageInfo || { hasNextPage: false } };
      }),
    load,
  };
  return pull;
}

function runPullMutation(ctx: Context, mutation: PullMutation): Promise<unknown> {
  switch (mutation.kind) {
    case "updatePullRequest":
      return ctx.execute(UpdatePullRequestDocument, { input: mutation.input });
    case "convertToDraft":
      return ctx.execute(ConvertPullRequestToDraftDocument, { input: mutation.input });
    case "markReadyForReview":
      return ctx.execute(MarkPullRequestReadyForReviewDocument, { input: mutation.input });
    default:
      return runIssueMutation(ctx, mutation);
  }
}
