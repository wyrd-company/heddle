import { nodeId } from "../refs.js";
import { ResponseShapeError } from "../transport/errors.js";
import type { Milestone } from "./milestones.js";

type RawMilestone = {
  id?: unknown;
  node_id?: unknown;
  number?: unknown;
  title?: unknown;
  description?: unknown;
  due_on?: unknown;
  state?: unknown;
};

export function parseMilestone(node: RawMilestone): Milestone {
  if (typeof node.id !== "number")
    throw new ResponseShapeError("Milestone.id", "missing or not a number");
  if (typeof node.number !== "number")
    throw new ResponseShapeError("Milestone.number", "missing or not a number");
  if (typeof node.title !== "string")
    throw new ResponseShapeError("Milestone.title", "missing or not a string");
  if (node.state !== "open" && node.state !== "closed")
    throw new ResponseShapeError("Milestone.state", "invalid state");

  const dueOn =
    typeof node.due_on === "string"
      ? (node.due_on.split("T")[0] as `${number}-${number}-${number}`)
      : null;

  return {
    id: nodeId(typeof node.node_id === "string" ? node.node_id : String(node.id)),
    number: node.number,
    name: node.title,
    description: typeof node.description === "string" ? node.description : null,
    dueOn,
    state: node.state,
  };
}
