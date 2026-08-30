// ---
// relationships:
//   implements: heddle
// ---

import {
  WaitNode,
  analyzeBlueprint,
  lintBlueprint,
  type NodeFunction,
} from "flowcraft";

import { BlueprintValidationError } from "./errors.js";
import {
  combineExclusiveLandings,
  combineLandings,
  combineMatchedLandings,
} from "./landing-combinations.js";
import type {
  ExpectedLandings,
  LifecycleBlueprint,
  LifecycleEdge,
  LifecycleEffect,
} from "./types.js";

export const internalNodeIdParameter = "__heddleNodeId";
const dispositionPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const placeholderNode: NodeFunction = async () => ({ output: null });

const outgoingEdges = (
  blueprint: LifecycleBlueprint,
  nodeId: string,
): LifecycleEdge[] => blueprint.edges.filter(({ source }) => source === nodeId);

export const validateBlueprint = (
  blueprint: LifecycleBlueprint,
  effects: Record<string, LifecycleEffect>,
): void => {
  const nodeIds = new Set<string>();
  for (const node of blueprint.nodes) {
    if (nodeIds.has(node.id)) {
      throw new BlueprintValidationError(
        `Blueprint contains duplicate node ID ${JSON.stringify(node.id)}`,
      );
    }
    nodeIds.add(node.id);
  }
  const registry: Record<string, NodeFunction | typeof WaitNode> = {
    wait: WaitNode,
  };
  for (const effectName of Object.keys(effects)) {
    registry[effectName] = placeholderNode;
  }
  const lint = lintBlueprint(blueprint, registry);
  if (!lint.isValid) {
    throw new BlueprintValidationError(
      lint.issues.map(({ code, message }) => `${code}: ${message}`).join("; "),
    );
  }

  const nodesById = new Map(blueprint.nodes.map((node) => [node.id, node]));
  for (const node of blueprint.nodes) {
    if (node.params?.[internalNodeIdParameter] !== undefined) {
      throw new BlueprintValidationError(
        `Node ${JSON.stringify(node.id)} uses reserved parameter ${internalNodeIdParameter}`,
      );
    }
    const isAgentWait =
      node.uses === "wait" &&
      (node.tools !== undefined ||
        node["todo-template"] !== undefined ||
        node["handoff-template"] !== undefined);
    if (
      node.handoff !== undefined &&
      node.handoff !== "standard" &&
      node.handoff !== "remediation"
    ) {
      throw new BlueprintValidationError(
        `Node ${JSON.stringify(node.id)} has invalid handoff metadata`,
      );
    }
    if (isAgentWait && node.handoff === undefined) {
      throw new BlueprintValidationError(
        `Agent wait node ${JSON.stringify(node.id)} has no handoff metadata`,
      );
    }
    if (
      isAgentWait &&
      (node["handoff-template"] === undefined ||
        !/^[0-9a-f]{40,64}$/.test(node["handoff-template"].blobHash) ||
        !/^handoff-templates\/[a-z]+(?:-[a-z]+)*\.md$/.test(
          node["handoff-template"].path,
        ))
    ) {
      throw new BlueprintValidationError(
        `Agent wait node ${JSON.stringify(node.id)} has no valid pinned handoff template`,
      );
    }
    if (node.uses !== "wait" && node.handoff !== undefined) {
      throw new BlueprintValidationError(
        `Non-wait node ${JSON.stringify(node.id)} must not declare handoff metadata`,
      );
    }
    if (node.uses !== "wait" && node["handoff-template"] !== undefined) {
      throw new BlueprintValidationError(
        `Non-wait node ${JSON.stringify(node.id)} must not declare handoff template metadata`,
      );
    }
    if (
      node.repo !== undefined &&
      (node.uses !== "wait" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(node.repo))
    ) {
      throw new BlueprintValidationError(
        `Node ${JSON.stringify(node.id)} has invalid repository metadata`,
      );
    }
    const dispositions = new Set<string>();
    const edges = outgoingEdges(blueprint, node.id);
    const usesDispositionRouting = edges.some(
      ({ disposition }) => disposition !== undefined,
    );
    if (node.uses === "wait" && edges.length === 0) {
      throw new BlueprintValidationError(
        `Wait node ${JSON.stringify(node.id)} has no disposition edges`,
      );
    }
    if (node.uses !== "wait" && !usesDispositionRouting) continue;
    for (const edge of edges) {
      if (edge.action !== undefined) {
        throw new BlueprintValidationError(
          `Disposition node ${JSON.stringify(node.id)} must use condition edges, not action edges`,
        );
      }
      const disposition = edge.disposition;
      if (disposition === undefined || !dispositionPattern.test(disposition)) {
        throw new BlueprintValidationError(
          `Node ${JSON.stringify(node.id)} has an invalid disposition`,
        );
      }
      if (dispositions.has(disposition)) {
        throw new BlueprintValidationError(
          `Node ${JSON.stringify(node.id)} repeats disposition ${JSON.stringify(disposition)}`,
        );
      }
      dispositions.add(disposition);
      const expectedCondition = `result.output.dispositions.${disposition}`;
      if (edge.condition !== expectedCondition) {
        throw new BlueprintValidationError(
          `Disposition ${JSON.stringify(disposition)} from wait node ${JSON.stringify(node.id)} must use condition ${JSON.stringify(expectedCondition)}`,
        );
      }
    }
  }

  for (const edge of blueprint.edges) {
    if (edge.action !== undefined) {
      throw new BlueprintValidationError(
        `Edge ${JSON.stringify(`${edge.source}->${edge.target}`)} must not use action routing`,
      );
    }
  }

  const analysis = analyzeBlueprint(blueprint);
  const cycleNodeIds = new Set(analysis.cycles.flat());
  for (const nodeId of cycleNodeIds) {
    const node = nodesById.get(nodeId);
    if (node?.config?.joinStrategy !== "any") {
      throw new BlueprintValidationError(
        `Cycle node ${JSON.stringify(nodeId)} must declare joinStrategy ${JSON.stringify("any")}`,
      );
    }
  }

  expectedLanding(blueprint, analysis.startNodeIds);
  for (const node of blueprint.nodes.filter(({ uses }) => uses === "wait")) {
    for (const edge of outgoingEdges(blueprint, node.id)) {
      expectedLanding(blueprint, [edge.target]);
    }
  }
};

export const dispositionsForNode = (
  blueprint: LifecycleBlueprint,
  nodeId: string,
): string[] =>
  outgoingEdges(blueprint, nodeId)
    .map(({ disposition }) => disposition)
    .filter((value): value is string => value !== undefined)
    .sort();

export const edgeForDisposition = (
  blueprint: LifecycleBlueprint,
  nodeId: string,
  disposition: string,
): LifecycleEdge | undefined =>
  outgoingEdges(blueprint, nodeId).find(
    (edge) => edge.disposition === disposition,
  );

export const expectedLanding = (
  blueprint: LifecycleBlueprint,
  entryNodeIds: string[],
): ExpectedLandings => {
  const nodesById = new Map(blueprint.nodes.map((node) => [node.id, node]));
  const visit = (nodeId: string, active: Set<string>): ExpectedLandings => {
    if (active.has(nodeId)) {
      throw new BlueprintValidationError(
        `Route through ${JSON.stringify(nodeId)} cycles without reaching a landing`,
      );
    }
    const node = nodesById.get(nodeId);
    if (node === undefined) {
      throw new BlueprintValidationError(
        `Expected landing references missing node ${JSON.stringify(nodeId)}`,
      );
    }
    if (node.uses === "wait") {
      return [{ awaitingNodeIds: [nodeId], terminalNodeIds: [] }];
    }
    const edges = outgoingEdges(blueprint, nodeId);
    if (edges.length === 0) {
      return [{ awaitingNodeIds: [], terminalNodeIds: [nodeId] }];
    }
    const nextActive = new Set(active).add(nodeId);
    const groups = edges.map(({ target }) => visit(target, nextActive));
    const conditionalCount = edges.filter(
      ({ condition }) => condition !== undefined,
    ).length;
    const dispositionCount = edges.filter(
      ({ disposition }) => disposition !== undefined,
    ).length;
    if (conditionalCount > 0 && conditionalCount !== edges.length) {
      throw new BlueprintValidationError(
        `Node ${JSON.stringify(nodeId)} mixes conditional and unconditional edges`,
      );
    }
    if (dispositionCount > 0 && dispositionCount !== edges.length) {
      throw new BlueprintValidationError(
        `Node ${JSON.stringify(nodeId)} mixes disposition and ordinary edges`,
      );
    }
    if (dispositionCount === edges.length) {
      return combineExclusiveLandings(groups);
    }
    return conditionalCount === edges.length
      ? combineMatchedLandings(groups)
      : combineLandings(groups);
  };

  const alternatives = combineLandings(
    entryNodeIds.map((nodeId) => visit(nodeId, new Set())),
  ).filter(
    ({ awaitingNodeIds, terminalNodeIds }) =>
      awaitingNodeIds.length > 0 || terminalNodeIds.length > 0,
  );
  if (alternatives.length === 0) {
    throw new BlueprintValidationError(
      `Route from ${entryNodeIds.map((id) => JSON.stringify(id)).join(", ")} has no wait or terminal landing`,
    );
  }
  for (const alternative of alternatives) {
    if (alternative.awaitingNodeIds.length > 1) {
      throw new BlueprintValidationError(
        `Route from ${entryNodeIds.map((id) => JSON.stringify(id)).join(", ")} can land at more than one wait node`,
      );
    }
    if (
      alternative.awaitingNodeIds.length > 0 &&
      alternative.terminalNodeIds.length > 0
    ) {
      throw new BlueprintValidationError(
        `Route from ${entryNodeIds.map((id) => JSON.stringify(id)).join(", ")} mixes wait and terminal landings`,
      );
    }
  }
  return [
    ...new Map(
      alternatives.map((alternative) => [
        JSON.stringify(alternative),
        alternative,
      ]),
    ).values(),
  ];
};

export const startLanding = (blueprint: LifecycleBlueprint): ExpectedLandings =>
  expectedLanding(blueprint, analyzeBlueprint(blueprint).startNodeIds);
