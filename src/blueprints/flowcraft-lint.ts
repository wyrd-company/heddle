// ---
// relationships:
//   implements: blueprint-authoring
// ---
import { lintBlueprint, type LinterIssue, type NodeFunction } from "flowcraft";

import {
  deriveFlowcraftBlueprint,
  type HeddleFlowcraftBlueprint,
} from "./flowcraft.js";
import { NODE_TYPE_REGISTRY } from "./node-types.js";
import type { Blueprint } from "./types.js";

const lintImplementation: NodeFunction = () => Promise.resolve({});
const flowcraftRegistry = Object.fromEntries(
  Object.keys(NODE_TYPE_REGISTRY).map((name) => [name, lintImplementation]),
);

function reachableNodeIds(blueprint: HeddleFlowcraftBlueprint): Set<string> {
  const incoming = new Set(blueprint.edges.map((edge) => edge.target));
  const starts = blueprint.nodes
    .map((node) => node.id)
    .filter((id) => !incoming.has(id));
  const configured = blueprint.metadata?.cycleEntryPoints;
  if (Array.isArray(configured)) {
    starts.push(
      ...configured.filter(
        (value): value is string => typeof value === "string",
      ),
    );
  }
  const reachable = new Set<string>();
  const pending = [...starts];
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (nodeId === undefined || reachable.has(nodeId)) continue;
    reachable.add(nodeId);
    pending.push(
      ...blueprint.edges
        .filter((edge) => edge.source === nodeId)
        .map((edge) => edge.target),
    );
  }
  return reachable;
}

export function lintDerivedBlueprint(blueprint: Blueprint): LinterIssue[] {
  const derived = deriveFlowcraftBlueprint(blueprint);
  const reachable = reachableNodeIds(derived);
  return lintBlueprint(derived, flowcraftRegistry).issues.filter(
    (issue) =>
      issue.code !== "ORPHAN_NODE" ||
      issue.nodeId === undefined ||
      !reachable.has(issue.nodeId),
  );
}
