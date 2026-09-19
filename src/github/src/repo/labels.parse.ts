import { nodeId } from "../refs.js";
import { ResponseShapeError } from "../transport/errors.js";
import type { Label } from "./labels.js";

export type RawLabel = { id?: unknown; name?: unknown; color?: unknown; description?: unknown };

export function parseLabel(node: RawLabel): Label {
  if (typeof node.id !== "string")
    throw new ResponseShapeError("Label.id", "missing or not a string");
  if (typeof node.name !== "string")
    throw new ResponseShapeError("Label.name", "missing or not a string");
  if (typeof node.color !== "string")
    throw new ResponseShapeError("Label.color", "missing or not a string");

  return {
    id: nodeId(node.id),
    name: node.name,
    color: node.color,
    description: typeof node.description === "string" ? node.description : null,
  };
}
