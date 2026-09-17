import { diffProperties, type CatalogAdapter } from "../catalog/adapter.js";
import type { Context } from "../context.js";
import { paginate, type Connection } from "../transport/paginate.js";
import { required } from "../transport/execute.js";
import type { NodeId } from "../refs.js";
import { scopes } from "../refs.js";
import type { IssueTypeColor } from "../schema/types.js";
import {
  CreateIssueTypeDocument,
  DeleteIssueTypeDocument,
  IssueTypesListDocument,
  OwnerLoadDocument,
  UpdateIssueTypeDocument,
} from "./documents.js";
import { parseIssueType } from "./issue-types.parse.js";

export interface IssueType {
  id: NodeId;
  name: string;
  description: string | null;
  color: IssueTypeColor;
  enabled: boolean;
}

export interface IssueTypeSpec {
  name: string;
  color?: IssueTypeColor;
  description?: string;
  enabled?: boolean;
}

export function createIssueTypesAdapter(
  ctx: Context,
  ownerLogin: string,
): CatalogAdapter<IssueType, IssueTypeSpec> {
  return {
    resource: "issue type",
    scope: scopes.issueTypes(ownerLogin),
    keyOf: (value) => value.name,
    async *list() {
      type IssueTypeNode = {
        id: string;
        name: string;
        description: string | null;
        color: string;
        isEnabled: boolean;
      };

      const fetcher = async (after: string | undefined): Promise<Connection<IssueTypeNode>> => {
        const data = await ctx.execute(IssueTypesListDocument, { login: ownerLogin, after });
        const org = (
          data as {
            organization?: {
              issueTypes?: {
                nodes?: unknown[];
                pageInfo?: { hasNextPage: boolean; endCursor?: string | null };
              };
            };
          }
        ).organization;
        return {
          nodes: org?.issueTypes?.nodes as (IssueTypeNode | null)[] | undefined,
          pageInfo: org?.issueTypes?.pageInfo ?? { hasNextPage: false },
        } as Connection<IssueTypeNode>;
      };

      for await (const node of paginate(fetcher)) {
        yield parseIssueType(node);
      }
    },
    async create(spec) {
      const data = await ctx.execute(OwnerLoadDocument, { login: ownerLogin });
      const found = required(
        (data as { repositoryOwner?: { id?: string } }).repositoryOwner,
        "repositoryOwner",
      );
      const ownerId = found.id as string;

      const result = await ctx.execute(CreateIssueTypeDocument, {
        input: {
          ownerId,
          name: spec.name,
          color: spec.color || "GRAY",
          description: spec.description,
          isEnabled: spec.enabled ?? true,
        },
      });
      const payload = (result as { createIssueType?: { issueType?: unknown } }).createIssueType;
      return parseIssueType(required(payload?.issueType, "createIssueType.issueType"));
    },
    async update(existing, patch) {
      const result = await ctx.execute(UpdateIssueTypeDocument, {
        input: {
          issueTypeId: existing.id,
          name: patch.name,
          color: patch.color,
          description: patch.description,
          isEnabled: patch.enabled,
        },
      });
      const payload = (result as { updateIssueType?: { issueType?: unknown } }).updateIssueType;
      return parseIssueType(required(payload?.issueType, "updateIssueType.issueType"));
    },
    async delete(existing) {
      await ctx.execute(DeleteIssueTypeDocument, { input: { issueTypeId: existing.id } });
    },
    diff: (spec, existing) => diffProperties(spec, existing, ["color", "description", "enabled"]),
  };
}
