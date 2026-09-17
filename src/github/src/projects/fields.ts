import type { CatalogAdapter } from "../catalog/adapter.js";
import type { Context } from "../context.js";
import type {
  ProjectV2IterationFieldConfigurationInput,
  ProjectV2SingleSelectFieldOptionInput,
} from "../generated/graphql.js";
import type { FieldId, IsoDate, NodeId, ProjectId } from "../refs.js";
import { scopes } from "../refs.js";
import { normaliseOption, type ReconcileOption } from "../schema/reconcile.js";
import type { FieldKind, FieldSpec, IterationSpec, OptionSpec } from "../schema/types.js";
import { NotFoundError } from "../transport/errors.js";
import { paginate } from "../transport/paginate.js";
import {
  CreateProjectFieldDocument,
  CreateProjectIssueFieldDocument,
  DeleteProjectFieldDocument,
  OwnerIssueFieldIdsDocument,
  ProjectFieldsDocument,
  UpdateProjectFieldDocument,
} from "./field-documents.js";
import { parseField } from "./parse.js";

export interface ProjectFieldOption {
  id: string;
  name: string;
  color: string;
  description: string;
}

export interface ProjectIteration {
  id: string;
  title: string;
  startDate: IsoDate;
  duration: number;
  completed: boolean;
}

export type ValueKind = Exclude<FieldKind, "issueField"> | "builtIn";

export interface ProjectField {
  id: FieldId;
  name: string;
  /** `issueField` when the field mirrors an organization issue field. */
  type: FieldKind | "builtIn";
  /** The kind of value the field holds; for issueField-backed fields, the org field's kind. */
  dataType: ValueKind;
  /** Populated for singleSelect and multiSelect, from the org field when mirrored. */
  options: ProjectFieldOption[];
  /** Completed and active iterations, oldest first. */
  iterations: ProjectIteration[];
  issueFieldId: NodeId | null;
}

export type ProjectFieldSpec = { name: string } & FieldSpec;

const customTypes = {
  text: "TEXT",
  number: "NUMBER",
  date: "DATE",
  singleSelect: "SINGLE_SELECT",
  multiSelect: "MULTI_SELECT",
  iteration: "ITERATION",
} as const;

/** Every manageable field of a project; built-in read-only fields are left out. */
export async function* listFields(ctx: Context, projectId: ProjectId): AsyncIterable<ProjectField> {
  const pages = paginate(async (after) => {
    const data = await ctx.execute(ProjectFieldsDocument, { id: projectId, after: after ?? null });
    const node = data.node;
    if (!node || !("fields" in node)) throw new NotFoundError("project", projectId);
    return node.fields;
  });
  for await (const node of pages) {
    const field = parseField(node);
    if (field.dataType !== "builtIn") yield field;
  }
}

/** The project's fields by name, loaded once per project until a catalog write. */
export function fieldTable(ctx: Context, projectId: ProjectId): Promise<Map<string, ProjectField>> {
  return ctx.cache.table(scopes.projectFields(projectId), async () => {
    const entries: [string, ProjectField][] = [];
    for await (const field of listFields(ctx, projectId)) entries.push([field.name, field]);
    return entries;
  });
}

export function createProjectFieldsAdapter(
  ctx: Context,
  projectId: ProjectId,
  ownerLogin: string,
): CatalogAdapter<ProjectField, ProjectFieldSpec> {
  return {
    resource: "project field",
    scope: scopes.projectFields(projectId),
    keyOf: (v) => v.name,
    list: () => listFields(ctx, projectId),
    async create(spec) {
      if (spec.type === "issueField") {
        const issueFieldId = await orgIssueFieldId(ctx, ownerLogin, spec.name);
        const data = await ctx.execute(CreateProjectIssueFieldDocument, {
          input: { projectId, issueFieldId },
        });
        return parseField(payload(data.createProjectV2IssueField?.projectV2Field));
      }
      const data = await ctx.execute(CreateProjectFieldDocument, {
        input: {
          projectId,
          name: spec.name,
          dataType: customTypes[spec.type],
          ...("options" in spec ? selectOptions(spec.type, spec.options.map(normaliseOption)) : {}),
          ...(spec.type === "iteration" ? { iterationConfiguration: iterationConfig(spec) } : {}),
        },
      });
      return parseField(payload(data.createProjectV2Field?.projectV2Field));
    },
    async update(existing, patch) {
      const data = await ctx.execute(UpdateProjectFieldDocument, {
        input: {
          fieldId: existing.id,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.options ? selectOptions(existing.dataType, patch.options) : {}),
        },
      });
      return parseField(payload(data.updateProjectV2Field?.projectV2Field));
    },
    async delete(existing) {
      await ctx.execute(DeleteProjectFieldDocument, { input: { fieldId: existing.id } });
    },
    diff: () => [],
    typeOf: (v) => v.type,
    optionsOf: (existing) => (existing.type === "issueField" ? undefined : existing.options),
    specOptionsOf: (spec) => ("options" in spec ? spec.options : undefined),
    reportUnmanaged: true,
  };
}

function payload<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new NotFoundError("project field", "payload");
  return value;
}

function selectOptions(kind: string, options: readonly ReconcileOption[]) {
  const list: ProjectV2SingleSelectFieldOptionInput[] = options.map((o) => ({
    ...(o.id !== undefined ? { id: o.id } : {}),
    name: o.name,
    color: (o.color ?? "GRAY") as ProjectV2SingleSelectFieldOptionInput["color"],
    description: o.description ?? "",
  }));
  return kind === "multiSelect" ? { multiSelectOptions: list } : { singleSelectOptions: list };
}

/** GitHub requires at least one iteration; three consecutive ones are created when none are declared. */
function iterationConfig(spec: {
  startDate: IsoDate;
  duration: number;
  iterations?: readonly IterationSpec[];
}): ProjectV2IterationFieldConfigurationInput {
  const iterations = spec.iterations ?? defaultIterations(spec.startDate, spec.duration);
  return {
    startDate: spec.startDate,
    duration: spec.duration,
    iterations: iterations.map((i) => ({
      title: i.title,
      startDate: i.startDate,
      duration: i.duration,
    })),
  };
}

function defaultIterations(startDate: IsoDate, duration: number): IterationSpec[] {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  return [0, 1, 2].map((n) => ({
    title: `Iteration ${n + 1}`,
    startDate: new Date(start + n * duration * 86_400_000).toISOString().slice(0, 10) as IsoDate,
    duration,
  }));
}

async function orgIssueFieldId(ctx: Context, login: string, name: string): Promise<string> {
  const data = await ctx.execute(OwnerIssueFieldIdsDocument, { login });
  if (!data.organization) throw new NotFoundError("organization", login);
  const found = (data.organization.issueFields?.nodes ?? []).find((f) => f?.name === name);
  if (!found) throw new NotFoundError("issue field", name);
  return found.id;
}

export type { OptionSpec };
