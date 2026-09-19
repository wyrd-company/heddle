import { createCatalog, type Catalog, type EnsureReport } from "../catalog/catalog.js";
import type { Context } from "../context.js";
import { resolveUserIds } from "../conversation/people.js";
import type { Issue } from "../issues/issue.js";
import type { Pull } from "../pulls/pull.js";
import {
  nodeId,
  type IssueRef,
  type ItemId,
  type NodeId,
  type ProjectId,
  type RepoRef,
} from "../refs.js";
import type { Repo } from "../repo/repo.js";
import type { IssueFieldSchema, ProjectSchema } from "../schema/types.js";
import { NotFoundError } from "../transport/errors.js";
import { required } from "../transport/execute.js";
import { paginate } from "../transport/paginate.js";
import {
  DeleteProjectDocument,
  LinkProjectRepositoryDocument,
  ProjectLoadDocument,
  UnlinkProjectRepositoryDocument,
  UpdateProjectDocument,
} from "./documents.js";
import { createProjectFieldsAdapter, type ProjectField, type ProjectFieldSpec } from "./fields.js";
import { createItem, type DraftSpec, type Item, type ItemData } from "./item.js";
import {
  AddProjectDraftDocument,
  AddProjectItemDocument,
  ItemsForContentDocument,
  ProjectItemsDocument,
} from "./item-documents.js";
import { parseItem } from "./parse.js";
import { itemData } from "./snapshot.js";
import { repoCoords, repositoryId, resolveContentId } from "./resolve.js";
import {
  listStatusUpdates,
  mapIterable,
  postStatus,
  type StatusInput,
  type StatusUpdate,
  type StatusUpdateData,
} from "./status.js";

export type ContentRef = IssueRef | NodeId;

export interface ProjectPatch {
  title?: string;
  shortDescription?: string;
  readme?: string;
  public?: boolean;
  closed?: boolean;
}

export interface ProjectData {
  id: ProjectId;
  number: number;
  title: string;
  shortDescription: string;
  readme: string;
  public: boolean;
  closed: boolean;
  url: string;
  repositories: `${string}/${string}`[];
}

export interface Project<P extends ProjectSchema, S extends IssueFieldSchema> {
  readonly id: ProjectId;
  readonly number: number;
  readonly schema: P;
  /** Empty changes when the project came from `open()`. */
  readonly lastEnsure: EnsureReport<ProjectField>;
  fields: Catalog<ProjectField, ProjectFieldSpec>;
  update(patch: ProjectPatch): Promise<void>;
  linkRepository(repo: Repo<S> | RepoRef): Promise<void>;
  unlinkRepository(repo: Repo<S> | RepoRef): Promise<void>;
  add(content: Issue<S> | Pull | ContentRef | { draft: DraftSpec }): Promise<Item<P, S>>;
  item(id: ItemId): Item<P, S>;
  itemFor(content: Issue<S> | Pull | ContentRef): Promise<Item<P, S> | undefined>;
  items(filter?: { archived?: boolean }): AsyncIterable<ItemData<P, S>>;
  postStatus(input: StatusInput): Promise<StatusUpdate>;
  statusUpdates(): AsyncIterable<StatusUpdateData>;
  delete(): Promise<void>;
  load(): Promise<ProjectData>;
}

export interface ProjectHandleArgs<P extends ProjectSchema, S extends IssueFieldSchema> {
  id: ProjectId;
  number: number;
  ownerLogin: string;
  schema: P;
  issueFields: S | undefined;
  lastEnsure: EnsureReport<ProjectField>;
}

export function createProject<P extends ProjectSchema, S extends IssueFieldSchema>(
  ctx: Context,
  args: ProjectHandleArgs<P, S>,
): Project<P, S> {
  const { id, number, ownerLogin, schema, issueFields, lastEnsure } = args;
  const item = (itemId: ItemId) =>
    createItem<P, S>(ctx, { projectId: id, ownerLogin, schema, issueFields, id: itemId });
  const repoId = (repo: Repo<S> | RepoRef) => repositoryId(ctx, repoCoords(repo));

  return {
    id,
    number,
    schema,
    lastEnsure,
    fields: createCatalog(ctx, createProjectFieldsAdapter(ctx, id, ownerLogin)),
    async update(patch) {
      await ctx.execute(UpdateProjectDocument, { input: { projectId: id, ...patch } });
    },
    async linkRepository(repo) {
      const repositoryId = await repoId(repo);
      await ctx.execute(LinkProjectRepositoryDocument, { input: { projectId: id, repositoryId } });
    },
    async unlinkRepository(repo) {
      const repositoryId = await repoId(repo);
      await ctx.execute(UnlinkProjectRepositoryDocument, {
        input: { projectId: id, repositoryId },
      });
    },
    async add(content) {
      if (typeof content === "object" && "draft" in content) {
        const draft = content.draft;
        const assigneeIds = draft.assignees
          ? await resolveUserIds(ctx, draft.assignees)
          : undefined;
        const data = await ctx.execute(AddProjectDraftDocument, {
          input: {
            projectId: id,
            title: draft.title,
            ...(draft.body !== undefined ? { body: draft.body } : {}),
            ...(assigneeIds ? { assigneeIds } : {}),
          },
        });
        const added = required(data.addProjectV2DraftIssue?.projectItem, "projectItem");
        return item(nodeId(added.id) as ItemId);
      }
      const contentId = await resolveContentId(ctx, content);
      const data = await ctx.execute(AddProjectItemDocument, {
        input: { projectId: id, contentId },
      });
      return item(nodeId(required(data.addProjectV2ItemById?.item, "item").id) as ItemId);
    },
    item,
    async itemFor(content) {
      const contentId = await resolveContentId(ctx, content);
      const data = await ctx.execute(ItemsForContentDocument, { id: contentId });
      const node = data.node;
      const items =
        node && "projectItems" in node
          ? node.projectItems?.nodes
          : node && "projectV2Items" in node
            ? node.projectV2Items.nodes
            : [];
      const found = (items ?? []).find((i) => i?.project.id === id);
      return found ? item(nodeId(found.id) as ItemId) : undefined;
    },
    items(filter) {
      const archived =
        filter?.archived === undefined
          ? (["ARCHIVED", "NOT_ARCHIVED"] as const)
          : filter.archived
            ? (["ARCHIVED"] as const)
            : (["NOT_ARCHIVED"] as const);
      return mapIterable(
        paginate(async (after) => {
          const data = await ctx.execute(ProjectItemsDocument, {
            id,
            after: after ?? null,
            archived: [...archived],
          });
          const node = data.node;
          if (!node || !("items" in node)) throw new NotFoundError("project", id);
          return node.items;
        }),
        (node) => itemData<P, S>(schema, parseItem(node)),
      );
    },
    postStatus: (input) => postStatus(ctx, id, input),
    statusUpdates: () => listStatusUpdates(ctx, id),
    async delete() {
      await ctx.execute(DeleteProjectDocument, { input: { projectId: id } });
    },
    async load() {
      const data = await ctx.execute(ProjectLoadDocument, { id });
      const node = data.node;
      if (!node || !("number" in node)) throw new NotFoundError("project", id);
      return {
        id,
        number: node.number,
        title: node.title,
        shortDescription: node.shortDescription ?? "",
        readme: node.readme ?? "",
        public: node.public,
        closed: node.closed,
        url: node.url,
        repositories: (node.repositories.nodes ?? [])
          .filter((r) => r !== null)
          .map((r) => r.nameWithOwner as `${string}/${string}`),
      };
    },
  };
}
