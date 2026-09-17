import { nodeId } from "../refs.js";
import { ResponseShapeError } from "../transport/errors.js";
import type { IssueType } from "./issue-types.js";

export function parseIssueType(node: unknown): IssueType {
  const item = node as {
    id?: unknown;
    name?: unknown;
    description?: unknown;
    color?: unknown;
    isEnabled?: unknown;
  };

  if (typeof item.id !== "string")
    throw new ResponseShapeError("IssueType.id", "missing or not a string");
  if (typeof item.name !== "string")
    throw new ResponseShapeError("IssueType.name", "missing or not a string");
  if (typeof item.isEnabled !== "boolean")
    throw new ResponseShapeError("IssueType.isEnabled", "missing or not a boolean");

  const colorStr = typeof item.color === "string" ? item.color : "GRAY";
  const validColors: Array<
    "GRAY" | "BLUE" | "GREEN" | "YELLOW" | "ORANGE" | "RED" | "PINK" | "PURPLE"
  > = ["GRAY", "BLUE", "GREEN", "YELLOW", "ORANGE", "RED", "PINK", "PURPLE"];
  const color = (
    validColors.includes(
      colorStr as "GRAY" | "BLUE" | "GREEN" | "YELLOW" | "ORANGE" | "RED" | "PINK" | "PURPLE",
    )
      ? colorStr
      : "GRAY"
  ) as (typeof validColors)[number];

  return {
    id: nodeId(item.id),
    name: item.name,
    description: typeof item.description === "string" ? item.description : null,
    color,
    enabled: item.isEnabled,
  };
}
