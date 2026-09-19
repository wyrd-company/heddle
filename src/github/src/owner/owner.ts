import { createCatalog, type Catalog, type EnsureReport } from "../catalog/catalog.js";
import type { Context } from "../context.js";
import {
  createProjectLocator,
  listProjects,
  type ProjectLocator,
  type ProjectSummary,
} from "../projects/locator.js";
import { nodeId, scopes, type NodeId } from "../refs.js";
import { createRepo, type Repo } from "../repo/repo.js";
import type { AnyProjectSchema, IssueFieldSchema, ProjectSchema } from "../schema/types.js";
import { required } from "../transport/execute.js";
import { OwnerLoadDocument } from "./documents.js";
import {
  createIssueFieldsAdapter,
  issueFieldSpecsFromSchema,
  type IssueField,
  type IssueFieldSpec,
} from "./issue-fields.js";
import { createIssueTypesAdapter, type IssueType, type IssueTypeSpec } from "./issue-types.js";

export interface OwnerData {
  id: NodeId;
  login: string;
  kind: "organization" | "user";
}

export interface IssueFieldsCatalog<S extends IssueFieldSchema> extends Catalog<
  IssueField,
  IssueFieldSpec
> {
  /** Without arguments, ensures the declared schema. */
  ensure(specs?: IssueFieldSpec | readonly IssueFieldSpec[]): Promise<EnsureReport<IssueField>>;
  readonly schema: S | undefined;
}

export interface Owner<S extends IssueFieldSchema> {
  readonly login: string;
  readonly issueFieldSchema: S | undefined;
  repo(name: string): Repo<S>;
  project<P extends ProjectSchema>(schema: P, opts?: { number?: number }): ProjectLocator<P, S>;
  project(number: number): ProjectLocator<AnyProjectSchema, S>;
  projects(): AsyncIterable<ProjectSummary>;
  issueTypes: Catalog<IssueType, IssueTypeSpec>;
  issueFields: IssueFieldsCatalog<S>;
  load(): Promise<OwnerData>;
}

export function createOwner<S extends IssueFieldSchema>(
  ctx: Context,
  login: string,
  issueFieldSchema: S | undefined,
): Owner<S> {
  const fields = createCatalog(ctx, createIssueFieldsAdapter(ctx, login));
  const issueFields: IssueFieldsCatalog<S> = {
    ...fields,
    schema: issueFieldSchema,
    ensure(specs) {
      if (specs !== undefined) return fields.ensure(specs);
      return fields.ensure(issueFieldSchema ? issueFieldSpecsFromSchema(issueFieldSchema) : []);
    },
  };

  const owner: Owner<S> = {
    login,
    issueFieldSchema,
    issueTypes: createCatalog(ctx, createIssueTypesAdapter(ctx, login)),
    issueFields,
    repo: (name) => createRepo(ctx, owner, name),
    project: ((schemaOrNumber: ProjectSchema | number, opts?: { number?: number }) =>
      typeof schemaOrNumber === "number"
        ? createProjectLocator(ctx, {
            ownerLogin: login,
            schema: undefined,
            number: schemaOrNumber,
            issueFields: issueFieldSchema,
          })
        : createProjectLocator(ctx, {
            ownerLogin: login,
            schema: schemaOrNumber,
            number: opts?.number,
            issueFields: issueFieldSchema,
          })) as Owner<S>["project"],
    projects: () => listProjects(ctx, login),
    load: () =>
      ctx.cache.remember(scopes.owners(), login, async () => {
        const data = await ctx.execute(OwnerLoadDocument, { login });
        const found = required(data.repositoryOwner, "repositoryOwner");
        return {
          id: nodeId(found.id),
          login: found.login,
          kind: found.__typename === "Organization" ? "organization" : "user",
        } satisfies OwnerData;
      }),
  };
  return owner;
}
