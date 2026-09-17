import type { Context } from "../context.js";
import { resolveUserIds } from "../conversation/people.js";
import { createIssue, type Issue } from "../issues/issue.js";
import {
  nodeId,
  parseIssueRef,
  scopes,
  type ItemId,
  type NodeId,
  type ProjectId,
  type RepoRef,
} from "../refs.js";
import type { Repo } from "../repo/repo.js";
import type {
  FieldValue,
  IssueFieldSchema,
  ProjectSchema,
  Snapshot,
  Values,
} from "../schema/types.js";
import { GitHubError, NotFoundError, ValidationError } from "../transport/errors.js";
import { required } from "../transport/execute.js";
import type { ItemPartsFragment } from "../generated/graphql.js";
import { fieldTable } from "./fields.js";
import {
  ArchiveItemDocument,
  ClearItemFieldValueDocument,
  ConvertDraftToIssueDocument,
  DeleteItemDocument,
  ItemLoadDocument,
  MoveItemDocument,
  SetItemIssueFieldValueDocument,
  UnarchiveItemDocument,
  UpdateItemFieldValueDocument,
  UpdateProjectDraftDocument,
} from "./item-documents.js";
import { parseItem, type RawItem } from "./parse.js";
import { repoCoords, repositoryId } from "./resolve.js";
import { itemData, pickValues } from "./snapshot.js";
import { encodeValue, fieldNamed } from "./values.js";

export interface DraftSpec {
  title: string;
  body?: string;
  assignees?: string[];
}

export interface Item<P extends ProjectSchema, S extends IssueFieldSchema> {
  readonly id: ItemId;
  /** One mutation per key, sequential. The first failure throws and names the field. */
  set(values: Values<P, S>): Promise<void>;
  get(): Promise<Snapshot<P, S>>;
  archive(): Promise<void>;
  unarchive(): Promise<void>;
  remove(): Promise<void>;
  /** `null` moves the item first. */
  moveAfter(other: Item<P, S> | ItemId | null): Promise<void>;
  /** Throws NOT_DRAFT for issue and pull request items. */
  editDraft(patch: Partial<DraftSpec>): Promise<void>;
  /** Returns a lazy handle to the new issue; call load() for its data. */
  convertToIssue(repo: Repo<S> | RepoRef): Promise<Issue<S>>;
  load(): Promise<ItemData<P, S>>;
}

export interface ItemData<P extends ProjectSchema, S extends IssueFieldSchema> {
  id: ItemId;
  type: "issue" | "pull" | "draft" | "redacted";
  /** Node id of the issue, pull request or draft. */
  contentId: NodeId | null;
  /** `owner/repo#n` for issues and pull requests. */
  contentRef: `${string}/${string}#${number}` | null;
  title: string | null;
  archived: boolean;
  values: Snapshot<P, S>;
}

export interface ItemHandleArgs<P extends ProjectSchema, S extends IssueFieldSchema> {
  projectId: ProjectId;
  ownerLogin: string;
  schema: P;
  issueFields: S | undefined;
  id: ItemId;
}

export function createItem<P extends ProjectSchema, S extends IssueFieldSchema>(
  ctx: Context,
  args: ItemHandleArgs<P, S>,
): Item<P, S> {
  const { projectId, schema, issueFields, id } = args;
  const scope = scopes.projectFields(projectId);

  const loadRaw = async (): Promise<RawItem> => {
    const data = await ctx.execute(ItemLoadDocument, { id });
    const node = data.node as ItemPartsFragment | Record<string, never> | null;
    if (!node || typeof node.id !== "string") throw new NotFoundError("project item", id);
    return parseItem(node as ItemPartsFragment);
  };

  const requireDraft = async () => {
    const raw = await loadRaw();
    if (raw.type !== "draft" || !raw.contentId) {
      throw new GitHubError("NOT_DRAFT", `project item ${id} is not a draft issue`);
    }
    return raw;
  };

  return {
    id,
    async set(values) {
      const fields = [...(await fieldTable(ctx, projectId)).values()];
      let issueId: NodeId | undefined;
      for (const [name, value] of Object.entries(values as Record<string, FieldValue | null>)) {
        if (value === undefined) continue;
        const encoded = encodeValue(fieldNamed(fields, name), value);
        await ctx.cache.withIdsFrom(scope, async () => {
          if (encoded.kind === "project") {
            const fieldId = encoded.field.id;
            if (encoded.value === null) {
              await ctx.execute(ClearItemFieldValueDocument, {
                input: { projectId, itemId: id, fieldId },
              });
            } else {
              await ctx.execute(UpdateItemFieldValueDocument, {
                input: { projectId, itemId: id, fieldId, value: encoded.value },
              });
            }
            return;
          }
          issueId ??= await issueContentId(loadRaw, name);
          await ctx.execute(SetItemIssueFieldValueDocument, {
            input: { issueId, issueFields: [encoded.value] },
          });
        });
      }
    },
    async get() {
      return pickValues<P, S>(schema, (await loadRaw()).values);
    },
    async archive() {
      await ctx.execute(ArchiveItemDocument, { input: { projectId, itemId: id } });
    },
    async unarchive() {
      await ctx.execute(UnarchiveItemDocument, { input: { projectId, itemId: id } });
    },
    async remove() {
      await ctx.execute(DeleteItemDocument, { input: { projectId, itemId: id } });
    },
    async moveAfter(other) {
      const afterId = other === null ? null : typeof other === "string" ? other : other.id;
      await ctx.execute(MoveItemDocument, { input: { projectId, itemId: id, afterId } });
    },
    async editDraft(patch) {
      const raw = await requireDraft();
      const assigneeIds = patch.assignees ? await resolveUserIds(ctx, patch.assignees) : undefined;
      await ctx.execute(UpdateProjectDraftDocument, {
        input: {
          draftIssueId: raw.contentId!,
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.body !== undefined ? { body: patch.body } : {}),
          ...(assigneeIds ? { assigneeIds } : {}),
        },
      });
    },
    async convertToIssue(repo) {
      const data = await ctx.execute(ConvertDraftToIssueDocument, {
        input: { itemId: id, repositoryId: await repositoryId(ctx, repoCoords(repo)) },
      });
      const content = required(data.convertProjectV2DraftIssueItemToIssue?.item, "item").content;
      if (!content || content.__typename !== "Issue") {
        throw new ValidationError(`project item ${id} did not convert to an issue`);
      }
      const ref = parseIssueRef(`${content.repository.nameWithOwner}#${content.number}` as never);
      return createIssue<S>(ctx, { coords: ref, schema: issueFields, id: nodeId(content.id) });
    },
    load: async () => itemData<P, S>(schema, await loadRaw()),
  };
}

async function issueContentId(load: () => Promise<RawItem>, field: string): Promise<NodeId> {
  const raw = await load();
  if (raw.type !== "issue" || !raw.contentId) {
    throw new ValidationError(`field "${field}" is an issue field; item ${raw.id} is not an issue`);
  }
  return nodeId(raw.contentId);
}
