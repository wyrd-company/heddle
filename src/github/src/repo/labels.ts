import { diffProperties, type CatalogAdapter } from "../catalog/adapter.js";
import type { Context } from "../context.js";
import { paginate, type Connection } from "../transport/paginate.js";
import { required } from "../transport/execute.js";
import type { NodeId, RepoCoordinates } from "../refs.js";
import { scopes } from "../refs.js";
import {
  CreateLabelDocument,
  DeleteLabelDocument,
  LabelsListDocument,
  UpdateLabelDocument,
} from "./documents.js";
import { parseLabel, type RawLabel } from "./labels.parse.js";

export interface Label {
  id: NodeId;
  name: string;
  /** Six hex digits, no leading hash. */
  color: string;
  description: string | null;
}

export interface LabelSpec {
  name: string;
  color?: string;
  description?: string;
}

export function createLabelsAdapter(
  ctx: Context,
  repo: RepoCoordinates,
): CatalogAdapter<Label, LabelSpec> {
  return {
    resource: "label",
    scope: scopes.labels(repo),
    keyOf: (value) => value.name,
    async *list() {
      type LabelNode = { id: string; name: string; color: string; description: string | null };

      const fetcher = async (after: string | undefined): Promise<Connection<LabelNode>> => {
        const data = await ctx.execute(LabelsListDocument, {
          owner: repo.owner,
          name: repo.repo,
          after,
        });
        const repository = (
          data as {
            repository?: {
              labels?: {
                nodes?: unknown[];
                pageInfo?: { hasNextPage: boolean; endCursor?: string | null };
              };
            };
          }
        ).repository;
        return {
          nodes: repository?.labels?.nodes as (LabelNode | null)[] | undefined,
          pageInfo: repository?.labels?.pageInfo ?? { hasNextPage: false },
        } as Connection<LabelNode>;
      };

      for await (const node of paginate(fetcher)) {
        yield parseLabel(node);
      }
    },
    async create(spec) {
      const result = await ctx.execute(CreateLabelDocument, {
        input: {
          repositoryId: (await loadRepoId(ctx, repo)) as string,
          name: spec.name,
          color: spec.color || "FFFFFF",
          description: spec.description,
        },
      });
      const payload = (result as { createLabel?: { label?: unknown } }).createLabel;
      return parseLabel(required(payload?.label, "createLabel.label") as RawLabel);
    },
    async update(existing, patch) {
      const result = await ctx.execute(UpdateLabelDocument, {
        input: {
          id: existing.id,
          name: patch.name,
          color: patch.color,
          description: patch.description,
        },
      });
      const payload = (result as { updateLabel?: { label?: unknown } }).updateLabel;
      return parseLabel(required(payload?.label, "updateLabel.label") as RawLabel);
    },
    async delete(existing) {
      await ctx.execute(DeleteLabelDocument, { input: { id: existing.id } });
    },
    diff: (spec, existing) => diffProperties(spec, existing, ["color", "description"]),
  };
}

async function loadRepoId(ctx: Context, repo: RepoCoordinates): Promise<string> {
  const data = await ctx.execute(LabelsListDocument, { owner: repo.owner, name: repo.repo });
  const found = (data as { repository?: { id?: string } }).repository;
  if (!found) throw new Error("Repository not found");
  return found.id || "";
}
