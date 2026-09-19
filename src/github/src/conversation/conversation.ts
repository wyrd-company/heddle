import type { Context } from "../context.js";
import type { CommentPageFragment } from "../generated/graphql.js";
import {
  AddCommentDocument,
  AddReactionDocument,
  CommentListDocument,
  RemoveReactionDocument,
} from "../issues/documents.js";
import { nodeId, type NodeId } from "../refs.js";
import { ResponseShapeError } from "../transport/errors.js";
import { required } from "../transport/execute.js";
import { paginate } from "../transport/paginate.js";
import { createComment, type Comment } from "./comment.js";

export type Reaction =
  "THUMBS_UP" | "THUMBS_DOWN" | "LAUGH" | "HOORAY" | "CONFUSED" | "HEART" | "ROCKET" | "EYES";

export interface CommentData {
  id: NodeId;
  body: string;
  author: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Shared by issues and pull requests. */
export interface Conversation {
  /** Resolved on first use: handles are lazy and know only their coordinates until then. */
  id(): Promise<NodeId>;
  comment(body: string): Promise<Comment>;
  comments(): AsyncIterable<CommentData>;
  react(content: Reaction): Promise<void>;
  unreact(content: Reaction): Promise<void>;
}

export function conversationMethods(ctx: Context, id: () => Promise<NodeId>): Conversation {
  return {
    id,
    async comment(body) {
      const data = await ctx.execute(AddCommentDocument, {
        input: { body, subjectId: await id() },
      });
      return createComment(
        ctx,
        nodeId(required(data.addComment?.commentEdge?.node?.id, "addComment.id")),
      );
    },
    comments() {
      return paginate(async (after) => {
        const data = await ctx.execute(CommentListDocument, {
          subjectId: await id(),
          after: after ?? null,
        });
        const node = required(data.node, "node");
        if (node.__typename !== "Issue" && node.__typename !== "PullRequest") {
          throw new ResponseShapeError(
            "node.__typename",
            `expected Issue or PullRequest, got ${node.__typename}`,
          );
        }
        return parsePage(node.comments);
      });
    },
    async react(content) {
      await ctx.execute(AddReactionDocument, { input: { subjectId: await id(), content } });
    },
    async unreact(content) {
      await ctx.execute(RemoveReactionDocument, { input: { subjectId: await id(), content } });
    },
  };
}

function parsePage(page: CommentPageFragment) {
  return {
    pageInfo: page.pageInfo,
    nodes: (page.nodes ?? []).map((c) =>
      c
        ? {
            id: nodeId(c.id),
            body: c.body,
            author: c.author?.login ?? null,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
          }
        : null,
    ),
  };
}
