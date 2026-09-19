import { createCatalog, type EnsureReport } from "../catalog/catalog.js";
import type { Context } from "../context.js";
import { OwnerLoadDocument } from "../owner/documents.js";
import { nodeId, scopes, type ProjectId } from "../refs.js";
import type { IssueFieldSchema, ProjectSchema } from "../schema/types.js";
import { AmbiguousError, NotFoundError, SchemaMismatchError } from "../transport/errors.js";
import { required } from "../transport/execute.js";
import { collect, paginate } from "../transport/paginate.js";
import {
  CreateProjectDocument,
  ProjectByNumberDocument,
  ProjectsByOwnerDocument,
} from "./documents.js";
import { createProjectFieldsAdapter, fieldTable, type ProjectField } from "./fields.js";
import { parseSummary } from "./parse.js";
import { createProject, type Project } from "./project.js";
import { specsFromSchema, verifySchema } from "./verify.js";

export interface ProjectSummary {
  id: ProjectId;
  number: number;
  title: string;
  closed: boolean;
  public: boolean;
  url: string;
}

export interface ProjectLocator<P extends ProjectSchema, S extends IssueFieldSchema> {
  /**
   * Find by number (if given) or title; create if missing; conform fields to the schema.
   * More than one open project with the title and no number throws AmbiguousError.
   */
  ensure(): Promise<Project<P, S>>;
  /** Open an existing project and verify it satisfies the schema. No writes. */
  open(): Promise<Project<P, S>>;
}

export interface LocatorArgs<P extends ProjectSchema, S extends IssueFieldSchema> {
  ownerLogin: string;
  /** Undefined for `owner.project(number)`: an undeclared project. */
  schema: P | undefined;
  number: number | undefined;
  issueFields: S | undefined;
}

export function createProjectLocator<P extends ProjectSchema, S extends IssueFieldSchema>(
  ctx: Context,
  args: LocatorArgs<P, S>,
): ProjectLocator<P, S> {
  const { ownerLogin, schema, number, issueFields } = args;
  const key = number !== undefined ? `#${number}` : (schema?.title ?? "");

  const find = async (): Promise<ProjectSummary | undefined> => {
    if (number !== undefined) return findByNumber(ctx, ownerLogin, number);
    if (!schema) throw new NotFoundError("project", key);
    const matches = (await collect(listProjects(ctx, ownerLogin, schema.title))).filter(
      (p) => p.title === schema.title && !p.closed,
    );
    if (matches.length > 1) {
      throw new AmbiguousError(
        "project",
        schema.title,
        matches.map((m) => m.number),
      );
    }
    return matches[0];
  };

  const empty: EnsureReport<ProjectField> = { changes: [], resources: [] };
  const handle = async (summary: ProjectSummary, lastEnsure: EnsureReport<ProjectField> = empty) =>
    createProject<P, S>(ctx, {
      id: summary.id,
      number: summary.number,
      ownerLogin,
      schema: schema ?? ({ title: summary.title, fields: {} } as unknown as P),
      issueFields,
      lastEnsure,
    });

  return {
    async open() {
      const summary = await find();
      if (!summary) throw new NotFoundError("project", key);
      if (schema) {
        const fields = [...(await fieldTable(ctx, summary.id)).values()];
        const gaps = verifySchema(schema, fields);
        if (gaps.length > 0) throw new SchemaMismatchError(gaps);
      }
      return handle(summary);
    },
    async ensure() {
      let summary = await find();
      if (!summary) {
        if (!schema) throw new NotFoundError("project", key);
        summary = await createEmptyProject(ctx, ownerLogin, schema.title);
      }
      if (!schema) return handle(summary);
      const fields = createCatalog(ctx, createProjectFieldsAdapter(ctx, summary.id, ownerLogin));
      const report = await fields.ensure(specsFromSchema(schema));
      return handle(summary, report);
    },
  };
}

async function findByNumber(ctx: Context, login: string, number: number) {
  const data = await ctx.execute(ProjectByNumberDocument, { login, number });
  const owner = data.repositoryOwner;
  const project = owner && "projectV2" in owner ? owner.projectV2 : null;
  return project ? parseSummary(project) : undefined;
}

async function createEmptyProject(ctx: Context, login: string, title: string) {
  const owner = await ctx.cache.remember(scopes.owners(), login, async () => {
    const data = await ctx.execute(OwnerLoadDocument, { login });
    const found = required(data.repositoryOwner, "repositoryOwner");
    return {
      id: nodeId(found.id),
      login: found.login,
      kind: found.__typename === "Organization" ? "organization" : "user",
    };
  });
  const data = await ctx.execute(CreateProjectDocument, { input: { ownerId: owner.id, title } });
  return parseSummary(required(data.createProjectV2?.projectV2, "createProjectV2.projectV2"));
}

/** Every project of the owner, or those matching a search query. */
export function listProjects(
  ctx: Context,
  ownerLogin: string,
  query?: string,
): AsyncIterable<ProjectSummary> {
  return mapSummaries(
    paginate(async (after) => {
      const data = await ctx.execute(ProjectsByOwnerDocument, {
        login: ownerLogin,
        search: query ?? null,
        after: after ?? null,
      });
      const owner = data.repositoryOwner;
      if (!owner || !("projectsV2" in owner)) throw new NotFoundError("owner", ownerLogin);
      return owner.projectsV2;
    }),
  );
}

async function* mapSummaries(
  source: AsyncIterable<Parameters<typeof parseSummary>[0]>,
): AsyncIterable<ProjectSummary> {
  for await (const node of source) yield parseSummary(node);
}
