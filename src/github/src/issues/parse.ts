import type {
  IssueCoreFragment,
  IssueLabelFragment,
  IssueLocatorFragment,
} from "../generated/graphql.js";
import type { Label } from "../repo/labels.js";
import type { Milestone } from "../repo/milestones.js";
import { formatIssueRef, nodeId, type IsoDate } from "../refs.js";
import type { IssueFieldSchema, IssueFieldValues } from "../schema/types.js";
import { ResponseShapeError } from "../transport/errors.js";
import type { IssueData, IssueStateReason } from "./issue.js";

type Locator = Pick<IssueLocatorFragment, "number" | "repository">;

function locatorRef(node: Locator): `${string}/${string}#${number}` {
  return formatIssueRef({
    owner: node.repository.owner.login,
    repo: node.repository.name,
    number: node.number,
  });
}

function locatorRefs(nodes: readonly (Locator | null)[] | null | undefined) {
  return (nodes ?? []).filter((n): n is Locator => n !== null).map(locatorRef);
}

function parseStateReason(reason: IssueCoreFragment["stateReason"]): IssueStateReason {
  switch (reason) {
    case "COMPLETED":
      return "completed";
    case "NOT_PLANNED":
      return "not-planned";
    case "DUPLICATE":
      return "duplicate";
    case "REOPENED":
      return "reopened";
    case null:
    case undefined:
      return null;
    default:
      throw new ResponseShapeError("issue.stateReason", `unexpected ${String(reason)}`);
  }
}

function parseMilestone(node: IssueCoreFragment["milestone"]): Milestone | null {
  if (!node) return null;
  return {
    id: nodeId(node.id),
    number: node.number,
    name: node.title,
    description: node.description,
    dueOn: node.dueOn ? (node.dueOn.slice(0, 10) as IsoDate) : null,
    state: node.state === "CLOSED" ? "closed" : "open",
  };
}

export function parseLabels(
  nodes: readonly (IssueLabelFragment | null)[] | null | undefined,
): Label[] {
  return (nodes ?? [])
    .filter((l): l is NonNullable<typeof l> => l !== null)
    .map((l) => ({ id: nodeId(l.id), name: l.name, color: l.color, description: l.description }));
}

type FieldValues = IssueCoreFragment["issueFieldValues"];
type FieldValueNode = NonNullable<NonNullable<NonNullable<FieldValues>["nodes"]>[number]>;

/** Field name and typed value of one issue field value node; undefined for unknown kinds. */
function fieldEntry(node: FieldValueNode): [string, unknown] | undefined {
  switch (node.__typename) {
    case "IssueFieldTextValue":
      return node.field && "name" in node.field ? [node.field.name, node.textValue] : undefined;
    case "IssueFieldNumberValue":
      return node.field && "name" in node.field ? [node.field.name, node.numberValue] : undefined;
    case "IssueFieldDateValue":
      return node.field && "name" in node.field ? [node.field.name, node.dateValue] : undefined;
    case "IssueFieldSingleSelectValue":
      return node.field && "name" in node.field ? [node.field.name, node.optionName] : undefined;
    case "IssueFieldMultiSelectValue":
      return node.field && "name" in node.field
        ? [node.field.name, node.options.map((o: { name: string }) => o.name)]
        : undefined;
    default:
      throw new ResponseShapeError("issue.issueFieldValues", "unexpected value kind");
  }
}

function parseFields<S extends IssueFieldSchema>(
  node: FieldValues,
  schema: S | undefined,
): IssueData<S>["fields"] {
  const fields: Record<string, unknown> = {};
  for (const name of Object.keys(schema ?? {})) fields[name] = null;
  for (const value of node?.nodes ?? []) {
    if (!value) continue;
    const entry = fieldEntry(value);
    if (entry && (!schema || entry[0] in schema)) fields[entry[0]] = entry[1] ?? null;
  }
  return fields as IssueData<S>["fields"];
}

export function parseIssue<S extends IssueFieldSchema>(
  issue: IssueCoreFragment,
  schema: S | undefined,
): IssueData<S> {
  if (issue.__typename !== "Issue") {
    throw new ResponseShapeError("issue.__typename", "expected Issue");
  }
  return {
    id: nodeId(issue.id),
    ref: formatIssueRef({
      owner: issue.repository.owner.login,
      repo: issue.repository.name,
      number: issue.number,
    }),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === "CLOSED" ? "closed" : "open",
    stateReason: parseStateReason(issue.stateReason),
    type: issue.issueType?.name ?? null,
    milestone: parseMilestone(issue.milestone),
    labels: parseLabels(issue.labels?.nodes),
    assignees: (issue.assignees.nodes ?? []).flatMap((a) => (a ? [a.login] : [])),
    fields: parseFields(issue.issueFieldValues, schema) as {
      [K in keyof S]: IssueFieldValues<S>[K] | null;
    },
    parent: issue.parent ? locatorRef(issue.parent) : null,
    subIssues: locatorRefs(issue.subIssues.nodes),
    blockedBy: locatorRefs(issue.blockedBy.nodes),
    blocking: locatorRefs(issue.blocking.nodes),
    duplicateOf: issue.duplicateOf ? locatorRef(issue.duplicateOf) : null,
    closedBy: locatorRefs(issue.closedByPullRequestsReferences?.nodes),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    url: issue.url,
  };
}
