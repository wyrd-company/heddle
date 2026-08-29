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
import type {
  ExpectedLanding,
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
    if (node.uses !== "wait") continue;

    const dispositions = new Set<string>();
    const edges = outgoingEdges(blueprint, node.id);
    if (edges.length === 0) {
      throw new BlueprintValidationError(
        `Wait node ${JSON.stringify(node.id)} has no disposition edges`,
      );
    }
    for (const edge of edges) {
      if (edge.action !== undefined) {
        throw new BlueprintValidationError(
          `Wait node ${JSON.stringify(node.id)} must use condition edges, not action edges`,
        );
      }
      const disposition = edge.disposition;
      if (disposition === undefined || !dispositionPattern.test(disposition)) {
        throw new BlueprintValidationError(
          `Wait node ${JSON.stringify(node.id)} has an invalid disposition`,
        );
      }
      if (dispositions.has(disposition)) {
        throw new BlueprintValidationError(
          `Wait node ${JSON.stringify(node.id)} repeats disposition ${JSON.stringify(disposition)}`,
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
    if (
      edge.disposition !== undefined &&
      nodesById.get(edge.source)?.uses !== "wait"
    ) {
      throw new BlueprintValidationError(
        `Only wait-node edges can declare a disposition`,
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
): ExpectedLanding => {
  const nodesById = new Map(blueprint.nodes.map((node) => [node.id, node]));
  const awaitingNodeIds = new Set<string>();
  const terminalNodeIds = new Set<string>();
  const visited = new Set<string>();
  const queue = [...entryNodeIds];

  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (nodeId === undefined || visited.has(nodeId)) continue;
    visited.add(nodeId);
    const node = nodesById.get(nodeId);
    if (node === undefined) {
      throw new BlueprintValidationError(
        `Expected landing references missing node ${JSON.stringify(nodeId)}`,
      );
    }
    if (node.uses === "wait") {
      awaitingNodeIds.add(nodeId);
      continue;
    }
    const edges = outgoingEdges(blueprint, nodeId);
    if (edges.length === 0) {
      terminalNodeIds.add(nodeId);
      continue;
    }
    queue.push(...edges.map(({ target }) => target));
  }

  if (awaitingNodeIds.size === 0 && terminalNodeIds.size === 0) {
    throw new BlueprintValidationError(
      `Route from ${entryNodeIds.map((id) => JSON.stringify(id)).join(", ")} has no wait or terminal landing`,
    );
  }
  if (awaitingNodeIds.size > 0 && terminalNodeIds.size > 0) {
    throw new BlueprintValidationError(
      `Route from ${entryNodeIds.map((id) => JSON.stringify(id)).join(", ")} mixes wait and terminal landings`,
    );
  }
  return {
    awaitingNodeIds: [...awaitingNodeIds].sort(),
    terminalNodeIds: [...terminalNodeIds].sort(),
  };
};

export const startLanding = (blueprint: LifecycleBlueprint): ExpectedLanding =>
  expectedLanding(blueprint, analyzeBlueprint(blueprint).startNodeIds);
