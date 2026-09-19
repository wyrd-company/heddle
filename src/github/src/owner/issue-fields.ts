import { diffProperties, type CatalogAdapter } from "../catalog/adapter.js";
import type { Context } from "../context.js";
import { paginate, type Connection } from "../transport/paginate.js";
import { required } from "../transport/execute.js";
import { GitHubError } from "../transport/errors.js";
import type { NodeId } from "../refs.js";
import { scopes } from "../refs.js";
import type {
  IssueFieldKind,
  IssueFieldSchema,
  IssueFieldSpecDecl,
  IssueFieldVisibility,
  OptionSpec,
  OptionColor,
} from "../schema/types.js";
import type { ReconcileOption } from "../schema/reconcile.js";
import type {
  CreateIssueFieldInput,
  UpdateIssueFieldInput,
  IssueFieldDataType,
  IssueFieldSingleSelectOptionColor,
} from "../generated/graphql.js";
import {
  CreateIssueFieldDocument,
  DeleteIssueFieldDocument,
  IssueFieldsListDocument,
  OwnerLoadDocument,
  UpdateIssueFieldDocument,
} from "./documents.js";
import { parseIssueField, type RawIssueField } from "./issue-fields.parse.js";

export interface IssueFieldOption {
  id: NodeId;
  name: string;
  color: string;
  description: string | null;
  priority: number | null;
}

export interface IssueField {
  id: NodeId;
  name: string;
  type: IssueFieldKind;
  description: string | null;
  visibility: IssueFieldVisibility;
  /** Empty for kinds without options. */
  options: IssueFieldOption[];
}

export type IssueFieldSpec = { name: string } & IssueFieldSpecDecl;

/** Turns the declared owner schema into catalog specs. */
export function issueFieldSpecsFromSchema(schema: IssueFieldSchema): IssueFieldSpec[] {
  return Object.entries(schema).map(([name, decl]) => ({ name, ...decl }));
}

const colorToIssueFieldColor: Record<OptionColor, IssueFieldSingleSelectOptionColor> = {
  GRAY: "GRAY",
  BLUE: "BLUE",
  GREEN: "GREEN",
  YELLOW: "YELLOW",
  ORANGE: "ORANGE",
  RED: "RED",
  PINK: "PINK",
  PURPLE: "PURPLE",
};

export function createIssueFieldsAdapter(
  ctx: Context,
  ownerLogin: string,
): CatalogAdapter<IssueField, IssueFieldSpec> {
  return {
    resource: "issue field",
    scope: scopes.issueFields(ownerLogin),
    keyOf: (value) => value.name,
    async *list() {
      type IssueFieldNode = {
        __typename: string;
        id: string;
        name: string;
        dataType: string;
        description: string | null;
        visibility: string;
        options?: unknown;
      };

      const fetcher = async (after: string | undefined): Promise<Connection<IssueFieldNode>> => {
        const data = await ctx.execute(IssueFieldsListDocument, { login: ownerLogin, after });
        const org = (
          data as {
            organization?: {
              issueFields?: {
                nodes?: unknown[];
                pageInfo?: { hasNextPage: boolean; endCursor?: string | null };
              };
            };
          }
        ).organization;
        return {
          nodes: org?.issueFields?.nodes as (IssueFieldNode | null)[] | undefined,
          pageInfo: org?.issueFields?.pageInfo ?? { hasNextPage: false },
        } as Connection<IssueFieldNode>;
      };

      for await (const node of paginate(fetcher)) {
        yield parseIssueField(node);
      }
    },
    async create(spec) {
      const data = await ctx.execute(OwnerLoadDocument, { login: ownerLogin });
      const found = required(
        (data as { repositoryOwner?: { id?: string } }).repositoryOwner,
        "repositoryOwner",
      );
      const ownerId = found.id as string;

      const input: CreateIssueFieldInput = {
        ownerId,
        name: spec.name,
        dataType: typeToDataType(spec.type),
        description: spec.description || null,
        visibility: spec.visibility || "ALL",
      };

      if ("options" in spec && spec.options) {
        input.options = (spec.options as OptionSpec[]).map((opt, index) => {
          const normalizedOpt = typeof opt === "string" ? { name: opt } : opt;
          return {
            name: normalizedOpt.name,
            color: colorToIssueFieldColor[normalizedOpt.color ?? "GRAY"],
            description: normalizedOpt.description,
            priority: index + 1,
          };
        });
      }

      const result = await ctx.execute(CreateIssueFieldDocument, { input });
      const payload = (result as { createIssueField?: { issueField?: unknown } }).createIssueField;
      return parseIssueField(
        required(payload?.issueField, "createIssueField.issueField") as RawIssueField,
      );
    },
    async update(existing, patch) {
      const input: UpdateIssueFieldInput = { id: existing.id };

      if (patch.name !== undefined) input.name = patch.name;
      if (patch.description !== undefined) input.description = patch.description;
      if (patch.visibility !== undefined) input.visibility = patch.visibility;
      if (patch.options !== undefined) {
        throw new GitHubError(
          "UNSUPPORTED",
          `Cannot change options of issue field "${existing.name}": GitHub's updateIssueField ` +
            "replaces the option set, rejects names that already exist, and mints new option " +
            "ids, which orphans existing values. Change the options in the GitHub UI.",
        );
      }

      const result = await ctx.execute(UpdateIssueFieldDocument, { input });
      const payload = (result as { updateIssueField?: { issueField?: unknown } }).updateIssueField;
      return parseIssueField(
        required(payload?.issueField, "updateIssueField.issueField") as RawIssueField,
      );
    },
    async delete(existing) {
      await ctx.execute(DeleteIssueFieldDocument, { input: { fieldId: existing.id } });
    },
    diff: (spec, existing) => diffProperties(spec, existing, ["description", "visibility"]),
    typeOf: (value) => (value as { type?: string }).type,
    optionsOf: (existing) =>
      existing.options.map(
        (opt) =>
          ({
            id: opt.id as string,
            name: opt.name,
            color: (opt.color as OptionColor) || undefined,
            description: opt.description || undefined,
          }) as ReconcileOption,
      ) as readonly ReconcileOption[],
    specOptionsOf: (spec) => ("options" in spec ? (spec.options as OptionSpec[]) : undefined),
  };
}

function typeToDataType(type: IssueFieldKind): IssueFieldDataType {
  const map: Record<IssueFieldKind, IssueFieldDataType> = {
    text: "TEXT",
    number: "NUMBER",
    date: "DATE",
    singleSelect: "SINGLE_SELECT",
    multiSelect: "MULTI_SELECT",
  };
  return map[type] || "TEXT";
}
