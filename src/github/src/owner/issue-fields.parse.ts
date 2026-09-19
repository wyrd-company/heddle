import type { IssueFieldKind, IssueFieldVisibility, OptionColor } from "../schema/types.js";
import { nodeId } from "../refs.js";
import { ResponseShapeError } from "../transport/errors.js";
import type { IssueField, IssueFieldOption } from "./issue-fields.js";

export type RawIssueField = {
  __typename?: string;
  id?: unknown;
  name?: unknown;
  dataType?: unknown;
  description?: unknown;
  visibility?: unknown;
  options?: unknown;
};

const dataTypeMap: Record<string, IssueFieldKind> = {
  TEXT: "text",
  NUMBER: "number",
  DATE: "date",
  SINGLE_SELECT: "singleSelect",
  MULTI_SELECT: "multiSelect",
};

const colorMap: Record<string, OptionColor> = {
  GRAY: "GRAY",
  BLUE: "BLUE",
  GREEN: "GREEN",
  YELLOW: "YELLOW",
  ORANGE: "ORANGE",
  RED: "RED",
  PINK: "PINK",
  PURPLE: "PURPLE",
};

export function parseIssueField(node: RawIssueField): IssueField {
  if (typeof node.id !== "string")
    throw new ResponseShapeError("IssueField.id", "missing or not a string");
  if (typeof node.name !== "string")
    throw new ResponseShapeError("IssueField.name", "missing or not a string");
  if (typeof node.dataType !== "string")
    throw new ResponseShapeError("IssueField.dataType", "missing or not a string");
  if (typeof node.visibility !== "string")
    throw new ResponseShapeError("IssueField.visibility", "missing or not a string");

  const type = dataTypeMap[node.dataType] || "text";
  const options = parseOptions(node.options, type);

  return {
    id: nodeId(node.id),
    name: node.name,
    type,
    description: typeof node.description === "string" ? node.description : null,
    visibility: (node.visibility as IssueFieldVisibility) || "ALL",
    options,
  };
}

function parseOptions(raw: unknown, type: IssueFieldKind): IssueFieldOption[] {
  if (!["singleSelect", "multiSelect"].includes(type)) return [];
  if (!Array.isArray(raw)) return [];

  return (raw as unknown[]).map((opt: unknown) => parseOption(opt));
}

function parseOption(raw: unknown): IssueFieldOption {
  const opt = raw as { id?: unknown; name?: unknown; color?: unknown; description?: unknown };
  if (typeof opt.id !== "string")
    throw new ResponseShapeError("IssueFieldOption.id", "missing or not a string");
  if (typeof opt.name !== "string")
    throw new ResponseShapeError("IssueFieldOption.name", "missing or not a string");

  const colorStr = typeof opt.color === "string" ? opt.color : "GRAY";
  const color = colorMap[colorStr] || "GRAY";

  return {
    id: nodeId(opt.id),
    name: opt.name,
    color,
    description: typeof opt.description === "string" ? opt.description : null,
    priority: null,
  };
}
