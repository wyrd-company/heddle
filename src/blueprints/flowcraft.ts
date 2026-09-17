// ---
// relationships:
//   implements:
//     - blueprint-authoring
//     - engine-and-run-model
// ---
import type {
  EdgeDefinition,
  NodeDefinition,
  WorkflowBlueprint,
} from "flowcraft";

import type {
  Blueprint,
  BlueprintEdge,
  BlueprintNode,
  JsonObject,
} from "./types.js";

export interface HeddleFlowcraftNode extends NodeDefinition {
  readonly description?: string;
  readonly stage?: boolean;
  readonly metadata?: JsonObject;
  readonly fixed?: readonly string[];
}

export interface HeddleFlowcraftBlueprint extends WorkflowBlueprint {
  readonly kind: Blueprint["kind"];
  readonly description?: string;
  readonly requires?: JsonObject;
  readonly inputs?: Readonly<Record<string, JsonObject>>;
  readonly outputs?: Readonly<Record<string, JsonObject>>;
  readonly nodes: HeddleFlowcraftNode[];
}

function deriveNode(id: string, node: BlueprintNode): HeddleFlowcraftNode {
  return {
    id,
    uses: node.uses,
    ...(node.params === undefined ? {} : { params: { ...node.params } }),
    ...(node.inputs === undefined ? {} : { inputs: node.inputs }),
    ...(node.config === undefined ? {} : { config: node.config }),
    ...(node.description === undefined
      ? {}
      : { description: node.description }),
    ...(node.stage === undefined ? {} : { stage: node.stage }),
    ...(node.metadata === undefined ? {} : { metadata: node.metadata }),
    ...(node.fixed === undefined ? {} : { fixed: node.fixed }),
  };
}

function deriveEdge(edge: BlueprintEdge): EdgeDefinition {
  return {
    source: edge.from,
    target: edge.to,
    ...(edge.when === undefined ? {} : { condition: edge.when }),
  };
}

export function deriveFlowcraftBlueprint(
  blueprint: Blueprint,
): HeddleFlowcraftBlueprint {
  const nodeIds = Object.keys(blueprint.nodes);
  const incoming = new Set((blueprint.edges ?? []).map((edge) => edge.to));
  const naturalStarts = nodeIds.filter((id) => !incoming.has(id));
  const cycleEntryPoints =
    naturalStarts.length === 0 && blueprint.entry !== undefined
      ? [blueprint.entry]
      : [];
  return {
    id: blueprint.id,
    kind: blueprint.kind,
    nodes: Object.entries(blueprint.nodes).map(([id, node]) =>
      deriveNode(id, node),
    ),
    edges: (blueprint.edges ?? []).map(deriveEdge),
    ...(blueprint.description === undefined
      ? {}
      : { description: blueprint.description }),
    ...(blueprint.metadata === undefined && cycleEntryPoints.length === 0
      ? {}
      : {
          metadata: {
            ...blueprint.metadata,
            ...(cycleEntryPoints.length === 0 ? {} : { cycleEntryPoints }),
          },
        }),
    ...(blueprint.requires === undefined
      ? {}
      : { requires: blueprint.requires }),
    ...(blueprint.inputs === undefined ? {} : { inputs: blueprint.inputs }),
    ...(blueprint.outputs === undefined ? {} : { outputs: blueprint.outputs }),
  };
}
