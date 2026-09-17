import type { Conversation } from "../conversation/conversation.js";
import { conversationMethods } from "../conversation/conversation.js";
import type { Context } from "../context.js";
import type { Pull } from "../pulls/pull.js";
import type { Label } from "../repo/labels.js";
import type { Milestone } from "../repo/milestones.js";
import {
  formatIssueRef,
  scopes,
  type IssueCoordinates,
  type IssueRef,
  type NodeId,
} from "../refs.js";
import type { IssueFieldSchema, IssueFieldValues } from "../schema/types.js";
import { NotFoundError } from "../transport/errors.js";
import { IssueLoadDocument } from "./documents.js";
import {
  applyRelations,
  closeIssue,
  moveSubIssue,
  reopenIssue,
  unmarkDuplicate,
} from "./issue.actions.js";
import { issueNames } from "./issue.names.js";
import { parseIssue } from "./parse.js";
import { planIssuePatch, type Delta, type PatchInputs } from "./patch.js";
import { deltaNames, runIssueMutation } from "./issue.run.js";
import type { IssueRelations } from "./relations.js";

export type { Delta } from "./patch.js";
export type IssueLike = Issue<IssueFieldSchema> | IssueRef | NodeId;
export type PullLike = Pull | IssueRef | NodeId;
export type IssueStateReason = "completed" | "not-planned" | "duplicate" | "reopened" | null;

export interface Issue<S extends IssueFieldSchema> extends Conversation {
  readonly ref: `${string}/${string}#${number}`;
  set(patch: IssuePatch<S>): Promise<void>;
  close(opts?: CloseIssue): Promise<void>;
  reopen(): Promise<void>;
  /** Clears the duplicate-of relationship set by close({ reason: "duplicate" }). */
  unmarkDuplicate(): Promise<void>;
  link(rel: IssueRelations): Promise<void>;
  unlink(rel: IssueRelations): Promise<void>;
  /** Reorders one sub-issue of this issue. `after: null` moves it first. */
  moveSubIssue(child: IssueLike, position: { after: IssueLike | null }): Promise<void>;
  load(): Promise<IssueData<S>>;
}

export type CloseIssue =
  { reason?: "completed" | "not-planned" } | { reason: "duplicate"; of: IssueLike };

export interface IssuePatch<S extends IssueFieldSchema> {
  title?: string;
  body?: string;
  /** Issue type by name. `null` clears. */
  type?: string | null;
  /** Milestone by title. `null` clears. */
  milestone?: string | null;
  labels?: Delta;
  assignees?: Delta;
  /** `null` deletes the value. */
  fields?: IssueFieldValues<S>;
}

export interface CreateIssue<S extends IssueFieldSchema> {
  title: string;
  body?: string;
  type?: string;
  milestone?: string;
  labels?: string[];
  assignees?: string[];
  fields?: IssueFieldValues<S>;
  parent?: IssueLike;
}

export interface IssueFilter {
  state?: "open" | "closed";
}

export interface IssueData<S extends IssueFieldSchema> {
  id: NodeId;
  ref: `${string}/${string}#${number}`;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  stateReason: IssueStateReason;
  type: string | null;
  milestone: Milestone | null;
  labels: Label[];
  assignees: string[];
  fields: { [K in keyof S]: IssueFieldValues<S>[K] | null };
  parent: `${string}/${string}#${number}` | null;
  subIssues: `${string}/${string}#${number}`[];
  blockedBy: `${string}/${string}#${number}`[];
  blocking: `${string}/${string}#${number}`[];
  duplicateOf: `${string}/${string}#${number}` | null;
  closedBy: `${string}/${string}#${number}`[];
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface IssueHandleArgs<S extends IssueFieldSchema> {
  coords: IssueCoordinates;
  schema: S | undefined;
  id?: NodeId;
}

export function createIssue<S extends IssueFieldSchema>(
  ctx: Context,
  args: IssueHandleArgs<S>,
): Issue<S> {
  const { coords, schema } = args;
  const ref = formatIssueRef(coords);
  let knownId = args.id;

  const load = async (): Promise<IssueData<S>> => {
    const data = await ctx.execute(IssueLoadDocument, coords);
    const issue = data.repository?.issue;
    if (!issue) throw new NotFoundError("issue", ref);
    const parsed = parseIssue(issue, schema);
    knownId = parsed.id;
    ctx.cache.set(scopes.issues(coords), String(coords.number), parsed.id);
    return parsed;
  };
  const id = async () => knownId ?? (await load()).id;
  const actor = { id, load };

  const set = async (patch: IssuePatch<S>): Promise<void> => {
    const names = issueNames(ctx, coords);
    const current = patch.labels || patch.assignees ? await load() : undefined;
    const inputs: PatchInputs = { issueId: await id() };
    if (patch.title !== undefined) inputs.title = patch.title;
    if (patch.body !== undefined) inputs.body = patch.body;
    if (patch.type !== undefined) inputs.issueTypeId = await names.issueTypeId(patch.type);
    if (patch.milestone !== undefined)
      inputs.milestoneId = await names.milestoneId(patch.milestone);
    if (patch.labels && current) {
      const wanted = deltaNames(patch.labels);
      inputs.labels = {
        delta: patch.labels,
        current: current.labels.map((l) => l.name),
        ids: new Map([
          ...current.labels.map((l) => [l.name, l.id] as const),
          ...(await names.labelIds(
            wanted.filter((n) => !current.labels.some((l) => l.name === n)),
          )),
        ]),
      };
    }
    if (patch.assignees && current) {
      inputs.assignees = {
        delta: patch.assignees,
        current: current.assignees,
        ids: await names.userIds([
          ...new Set([...current.assignees, ...deltaNames(patch.assignees)]),
        ]),
      };
    }
    if (patch.fields) inputs.fields = await names.fieldWrites(patch.fields);
    for (const mutation of planIssuePatch(inputs)) await runIssueMutation(ctx, mutation);
  };

  return {
    ref,
    ...conversationMethods(ctx, id),
    set,
    close: (opts) => closeIssue(ctx, actor, opts),
    reopen: () => reopenIssue(ctx, actor),
    unmarkDuplicate: () => unmarkDuplicate(ctx, actor),
    link: (rel) => applyRelations(ctx, actor, rel, "link"),
    unlink: (rel) => applyRelations(ctx, actor, rel, "unlink"),
    moveSubIssue: (child, position) => moveSubIssue(ctx, actor, child, position),
    load,
  };
}

export { createIssueInRepo, listIssues } from "./issue.create.js";
