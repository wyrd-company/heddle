import type { Comment } from "../conversation/comment.js";
import { createComment } from "../conversation/comment.js";
import type { Context } from "../context.js";
import type { NodeId } from "../refs.js";
import { nodeId } from "../refs.js";
import { ResponseShapeError } from "../transport/errors.js";
import {
  DismissPullRequestReviewDocument,
  UpdatePullRequestReviewDocument,
  AddPullRequestReviewThreadReplyDocument,
  ResolveReviewThreadDocument,
  SubmitPullRequestReviewDocument,
  UnresolveReviewThreadDocument,
} from "./documents.reviews.js";
import type { DiffSide } from "../generated/graphql.js";

export interface Review {
  readonly id: NodeId;
  dismiss(message: string): Promise<void>;
  edit(body: string): Promise<void>;
}

export interface Thread {
  readonly id: NodeId;
  reply(body: string): Promise<Comment>;
  resolve(): Promise<void>;
  unresolve(): Promise<void>;
}

export interface ThreadData {
  id: NodeId;
  path: string;
  line: number | null;
  startLine: number | null;
  diffSide: DiffSide;
  isResolved: boolean;
  isOutdated: boolean;
  comments: { id: NodeId; body: string; author: string | null }[];
}

export function createReview(ctx: Context, id: NodeId): Review {
  return {
    id,
    dismiss: async (message: string) => {
      await ctx.execute(DismissPullRequestReviewDocument, {
        input: { pullRequestReviewId: id, message },
      });
    },
    edit: async (body: string) => {
      await ctx.execute(UpdatePullRequestReviewDocument, {
        input: { pullRequestReviewId: id, body },
      });
    },
  };
}

export function createThread(ctx: Context, id: NodeId): Thread {
  return {
    id,
    reply: async (body: string) => {
      const result = await ctx.execute(AddPullRequestReviewThreadReplyDocument, {
        input: { pullRequestReviewThreadId: id, body },
      });
      const comment = result.addPullRequestReviewThreadReply?.comment;
      if (!comment) throw new ResponseShapeError("reply", "missing comment");
      await submitPendingReview(ctx, comment.pullRequestReview);
      return createComment(ctx, nodeId(comment.id));
    },
    resolve: async () => {
      await ctx.execute(ResolveReviewThreadDocument, { input: { threadId: id } });
    },
    unresolve: async () => {
      await ctx.execute(UnresolveReviewThreadDocument, { input: { threadId: id } });
    },
  };
}

/**
 * A thread or reply added outside a review lands in an implicit pending review, and
 * GitHub allows one pending review per author. Submitting it as a comment makes the
 * thread visible and leaves the author free to review again.
 */
export async function submitPendingReview(
  ctx: Context,
  review: { id: string; state: string } | null | undefined,
): Promise<void> {
  if (!review || review.state !== "PENDING") return;
  await ctx.execute(SubmitPullRequestReviewDocument, {
    input: { pullRequestReviewId: review.id, event: "COMMENT" },
  });
}
