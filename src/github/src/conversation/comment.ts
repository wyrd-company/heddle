import type { Context } from "../context.js";
import type { NodeId } from "../refs.js";
import {
  UpdateCommentDocument,
  DeleteCommentDocument,
  AddReactionDocument,
  RemoveReactionDocument,
} from "../issues/documents.js";
import type { Reaction } from "./conversation.js";

export interface Comment {
  readonly id: NodeId;
  edit(body: string): Promise<void>;
  delete(): Promise<void>;
  react(content: Reaction): Promise<void>;
  unreact(content: Reaction): Promise<void>;
}

export function createComment(ctx: Context, id: NodeId): Comment {
  return {
    id,
    async edit(body: string) {
      await ctx.execute(UpdateCommentDocument, { input: { id, body } });
    },
    async delete() {
      await ctx.execute(DeleteCommentDocument, { input: { id } });
    },
    async react(content: Reaction) {
      await ctx.execute(AddReactionDocument, { input: { subjectId: id, content } });
    },
    async unreact(content: Reaction) {
      await ctx.execute(RemoveReactionDocument, { input: { subjectId: id, content } });
    },
  };
}
