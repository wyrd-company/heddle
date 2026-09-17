import type {
  IssueFieldRefFragment,
  ItemPartsFragment,
  ItemValuePartsFragment,
  ProjectFieldPartsFragment,
  ProjectSummaryPartsFragment,
  StatusUpdatePartsFragment,
} from "../generated/graphql.js";
import { nodeId, type FieldId, type IsoDate, type ItemId, type ProjectId } from "../refs.js";
import type { FieldValue } from "../schema/types.js";
import { ResponseShapeError } from "../transport/errors.js";
import type { ProjectField, ProjectFieldOption, ProjectIteration, ValueKind } from "./fields.js";
import type { ProjectSummary } from "./locator.js";
import type { StatusUpdateData } from "./status.js";

const dataTypes: Record<string, ValueKind> = {
  TEXT: "text",
  NUMBER: "number",
  DATE: "date",
  SINGLE_SELECT: "singleSelect",
  MULTI_SELECT: "multiSelect",
  ITERATION: "iteration",
};

export function parseField(node: ProjectFieldPartsFragment): ProjectField {
  const dataType = dataTypes[node.dataType] ?? "builtIn";
  const issueField = "issueField" in node ? node.issueField : null;
  const field: ProjectField = {
    id: nodeId(node.id) as FieldId,
    name: node.name,
    type: node.isIssueField ? "issueField" : dataType,
    dataType,
    options: [],
    iterations: [],
    issueFieldId: issueField ? nodeId(issueField.id) : null,
  };
  if (node.__typename === "ProjectV2SingleSelectField") field.options = node.options.map(option);
  if (node.__typename === "ProjectV2MultiSelectField") {
    field.options = node.multiSelectOptions.map(option);
  }
  if (field.options.length === 0 && issueField) field.options = issueFieldOptions(issueField);
  if (node.__typename === "ProjectV2IterationField") {
    const { iterations, completedIterations } = node.configuration;
    field.iterations = [
      ...completedIterations.map((i) => iteration(i, true)),
      ...iterations.map((i) => iteration(i, false)),
    ];
  }
  return field;
}

function option(o: { id: string; name: string; color: string; description: string | null }) {
  return { id: o.id, name: o.name, color: o.color, description: o.description ?? "" };
}

function issueFieldOptions(ref: IssueFieldRefFragment): ProjectFieldOption[] {
  if ("options" in ref) return ref.options.map(option);
  return [];
}

function iteration(
  i: { id: string; title: string; startDate: string; duration: number },
  completed: boolean,
): ProjectIteration {
  return {
    id: i.id,
    title: i.title,
    startDate: i.startDate as IsoDate,
    duration: i.duration,
    completed,
  };
}

export function parseSummary(node: ProjectSummaryPartsFragment): ProjectSummary {
  return {
    id: nodeId(node.id) as ProjectId,
    number: node.number,
    title: node.title,
    closed: node.closed,
    public: node.public,
    url: node.url,
  };
}

export function parseStatus(node: StatusUpdatePartsFragment): StatusUpdateData {
  return {
    id: nodeId(node.id),
    status: node.status,
    body: node.body ?? "",
    startDate: (node.startDate as IsoDate | null) ?? null,
    targetDate: (node.targetDate as IsoDate | null) ?? null,
    createdAt: node.createdAt,
  };
}

/** An item as read from the wire, before schema-shaped values are picked. */
export interface RawItem {
  id: ItemId;
  type: "issue" | "pull" | "draft" | "redacted";
  archived: boolean;
  contentId: string | null;
  contentRef: `${string}/${string}#${number}` | null;
  title: string | null;
  /** Decoded values keyed by field name. Read-only kinds are absent. */
  values: Record<string, FieldValue | null>;
}

const itemTypes = {
  ISSUE: "issue",
  PULL_REQUEST: "pull",
  DRAFT_ISSUE: "draft",
  REDACTED: "redacted",
} as const;

export function parseItem(node: ItemPartsFragment): RawItem {
  const content = node.content;
  const item: RawItem = {
    id: nodeId(node.id) as ItemId,
    type: itemTypes[node.type],
    archived: node.isArchived,
    contentId: content?.id ?? null,
    contentRef: null,
    title: content?.title ?? null,
    values: {},
  };
  if (content && content.__typename !== "DraftIssue") {
    item.contentRef =
      `${content.repository.nameWithOwner}#${content.number}` as RawItem["contentRef"];
  }
  for (const value of node.fieldValues.nodes ?? []) {
    if (!value) continue;
    const decoded = decodeValue(value);
    if (decoded) item.values[decoded.name] = decoded.value;
  }
  return item;
}

function decodeValue(v: ItemValuePartsFragment): { name: string; value: FieldValue | null } | null {
  if (!("field" in v) || !("name" in v.field)) return null;
  const name = v.field.name;
  switch (v.__typename) {
    case "ProjectV2ItemFieldTextValue":
      return { name, value: v.text ?? null };
    case "ProjectV2ItemFieldNumberValue":
      return { name, value: v.number ?? null };
    case "ProjectV2ItemFieldDateValue":
      return { name, value: v.date ?? null };
    case "ProjectV2ItemFieldSingleSelectValue":
      return { name, value: v.name ?? null };
    case "ProjectV2ItemFieldIterationValue":
      return { name, value: { title: v.title } };
    case "ProjectV2ItemFieldMultiSelectValue":
      return { name, value: (v.options ?? []).map((o) => o.name) };
    case "ProjectV2ItemIssueFieldValue": {
      const inner = v.issueFieldValue;
      if (!inner) return { name, value: null };
      switch (inner.__typename) {
        case "IssueFieldTextValue":
          return { name, value: inner.text };
        case "IssueFieldNumberValue":
          return { name, value: inner.number };
        case "IssueFieldDateValue":
          return { name, value: inner.date };
        case "IssueFieldSingleSelectValue":
          return { name, value: inner.name };
        case "IssueFieldMultiSelectValue":
          return { name, value: inner.options.map((o) => o.name) };
        default:
          throw new ResponseShapeError("fieldValues.issueFieldValue", "unknown value kind");
      }
    }
    default:
      return null;
  }
}
