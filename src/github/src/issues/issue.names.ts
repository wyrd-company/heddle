import type { Context } from "../context.js";
import { createIssueFieldsAdapter, type IssueField } from "../owner/issue-fields.js";
import { createIssueTypesAdapter } from "../owner/issue-types.js";
import { resolveUserIds } from "../conversation/people.js";
import { createLabelsAdapter } from "../repo/labels.js";
import { createMilestonesAdapter } from "../repo/milestones.js";
import { scopes, type NodeId, type RepoCoordinates } from "../refs.js";
import type { IssueFieldSchema, IssueFieldValues } from "../schema/types.js";
import { NotFoundError } from "../transport/errors.js";
import { encodeIssueFieldValue } from "./field-values.js";

async function table<T extends { id: NodeId }>(
  ctx: Context,
  scope: string,
  list: () => AsyncIterable<T>,
  keyOf: (item: T) => string,
): Promise<Map<string, T>> {
  return ctx.cache.table<T>(scope, async () => {
    const entries: [string, T][] = [];
    for await (const item of list()) entries.push([keyOf(item), item]);
    return entries;
  });
}

function lookup<T extends { id: NodeId }>(map: Map<string, T>, resource: string, name: string) {
  const found = map.get(name);
  if (!found) throw new NotFoundError(resource, name);
  return found;
}

/** Name to id resolution for everything an issue patch or creation can name. */
export function issueNames(ctx: Context, repo: RepoCoordinates) {
  const labels = () =>
    table(
      ctx,
      scopes.labels(repo),
      () => createLabelsAdapter(ctx, repo).list(),
      (l) => l.name,
    );
  const milestones = () =>
    table(
      ctx,
      scopes.milestones(repo),
      () => createMilestonesAdapter(ctx, repo).list(),
      (m) => m.name,
    );
  const types = () =>
    table(
      ctx,
      scopes.issueTypes(repo.owner),
      () => createIssueTypesAdapter(ctx, repo.owner).list(),
      (t) => t.name,
    );
  const fields = () =>
    table(
      ctx,
      scopes.issueFields(repo.owner),
      () => createIssueFieldsAdapter(ctx, repo.owner).list(),
      (f) => f.name,
    );

  return {
    async labelIds(names: readonly string[]): Promise<Map<string, NodeId>> {
      const all = await labels();
      return new Map(names.map((name) => [name, lookup(all, "label", name).id]));
    },
    async milestoneId(name: string | null): Promise<NodeId | null> {
      return name === null ? null : lookup(await milestones(), "milestone", name).id;
    },
    async issueTypeId(name: string | null): Promise<NodeId | null> {
      return name === null ? null : lookup(await types(), "issue type", name).id;
    },
    async userIds(logins: readonly string[]): Promise<Map<string, NodeId>> {
      const ids = await resolveUserIds(ctx, logins);
      return new Map(logins.map((login, i) => [login, ids[i]!]));
    },
    async field(name: string): Promise<IssueField> {
      return lookup(await fields(), "issue field", name);
    },
    /** Encoded writes for every key of a typed field patch, in key order. */
    async fieldWrites<S extends IssueFieldSchema>(values: IssueFieldValues<S>) {
      const all = await fields();
      return Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => encodeIssueFieldValue(lookup(all, "issue field", name), value));
    },
  };
}
