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
  agentNameListNames,
  agentNameThemeKindForList,
  type AgentNameThemeKind,
} from "../agent-names/index.js";
import { RESOLVED_SESSION_RUNTIME_MODES } from "../persistence/index.js";
import {
  isProviderAlias,
  TaskProviderAliasError,
  type TaskProviderAliasMap,
} from "../provider-alias.js";
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
  MechanicalNodeUse,
} from "./types.js";
import { mechanicalNodeUses } from "./types.js";

export const internalNodeIdParameter = "__heddleNodeId";
const dispositionPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const placeholderNode: NodeFunction = async () => ({ output: null });
const mechanicalNodeUseSet = new Set<string>(mechanicalNodeUses);
const agentNameListNameSet = new Set<string>(agentNameListNames);
export const agentNameThemeKindForBlueprint = (
  blueprint: LifecycleBlueprint,
): AgentNameThemeKind | undefined => {
  const lists = new Set(
    blueprint.nodes.flatMap((node) =>
      node["assign-agent-name"] === undefined
        ? []
        : [node["assign-agent-name"]],
    ),
  );
  if (lists.size === 0) return undefined;
  const kinds = new Set([...lists].map(agentNameThemeKindForList));
  if (kinds.size !== 1) {
    throw new BlueprintValidationError(
      `Blueprint agent-name lists require more than one theme kind: ${JSON.stringify([...lists].sort())}`,
    );
  }
  return kinds.values().next().value;
};

export const validateTaskProviderAliases = (
  blueprint: LifecycleBlueprint,
  taskId: number,
  aliases: TaskProviderAliasMap | undefined,
): void => {
  if (aliases === undefined) return;
  const nodesById = new Map(blueprint.nodes.map((node) => [node.id, node]));
  for (const stageId of Object.keys(aliases)) {
    const node = nodesById.get(stageId);
    if (node === undefined) {
      throw new TaskProviderAliasError(
        taskId,
        `key ${JSON.stringify(stageId)} names no node in the resolved blueprint`,
      );
    }
    if (node.uses !== "wait") {
      const kind = mechanicalNodeUseSet.has(node.uses)
        ? "a mechanical node"
        : "a non-wait node";
      throw new TaskProviderAliasError(
        taskId,
        `key ${JSON.stringify(stageId)} names ${kind}; only wait nodes can select providers`,
      );
    }
  }
};

export const validateBlueprintBoardStatuses = (
  blueprint: LifecycleBlueprint,
): void => {
  const statuses = blueprint["board-statuses"];
  for (const uses of Object.keys(statuses ?? {})) {
    if (!mechanicalNodeUseSet.has(uses)) {
      throw new BlueprintValidationError(
        `Blueprint board-statuses names unknown mechanical node use ${JSON.stringify(uses)}`,
      );
    }
  }
  for (const uses of new Set(
    blueprint.nodes
      .map((node) => node.uses)
      .filter((uses): uses is MechanicalNodeUse =>
        mechanicalNodeUseSet.has(uses),
      ),
  )) {
    const status = statuses?.[uses];
    if (typeof status !== "string" || status.trim() === "") {
      throw new BlueprintValidationError(
        `Blueprint board-statuses is missing mechanical node use ${JSON.stringify(uses)}`,
      );
    }
  }
};

export const boardStatusForMechanicalNode = (
  blueprint: LifecycleBlueprint,
  uses: MechanicalNodeUse,
): string => {
  validateBlueprintBoardStatuses(blueprint);
  const status = blueprint["board-statuses"]?.[uses];
  if (status === undefined) {
    throw new BlueprintValidationError(
      `Blueprint board-statuses is missing mechanical node use ${JSON.stringify(uses)}`,
    );
  }
  return status;
};

const outgoingEdges = (
  blueprint: LifecycleBlueprint,
  nodeId: string,
): LifecycleEdge[] => blueprint.edges.filter(({ source }) => source === nodeId);

export const validateBlueprint = (
  blueprint: LifecycleBlueprint,
  effects: Record<string, LifecycleEffect>,
): void => {
  validateBlueprintBoardStatuses(blueprint);
  agentNameThemeKindForBlueprint(blueprint);
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
  for (const node of blueprint.nodes.filter(({ uses }) => uses === "merge")) {
    const inbound = blueprint.edges.filter(({ target }) => target === node.id);
    if (
      inbound.length === 0 ||
      inbound.some(
        (edge) =>
          nodesById.get(edge.source)?.uses !== "wait" ||
          edge.disposition !== "approve" ||
          !blueprint.edges.some(
            (candidate) =>
              candidate.target === edge.source &&
              nodesById.get(candidate.source)?.uses === "review-snapshot",
          ),
      )
    ) {
      throw new BlueprintValidationError(
        `Merge node ${JSON.stringify(node.id)} must be reached only from a review wait node approve disposition`,
      );
    }
  }
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
        node["handoff-template"] !== undefined ||
        node["assign-agent-name"] !== undefined ||
        node.skills !== undefined);
    const agentNameList = node["assign-agent-name"] as unknown;
    if (
      agentNameList !== undefined &&
      (typeof agentNameList !== "string" ||
        !agentNameListNameSet.has(agentNameList))
    ) {
      throw new BlueprintValidationError(
        `Node ${JSON.stringify(node.id)} assign-agent-name is invalid`,
      );
    }
    const providerAlias = node["provider-alias"] as unknown;
    if (providerAlias !== undefined && !isProviderAlias(providerAlias)) {
      throw new BlueprintValidationError(
        `Node ${JSON.stringify(node.id)} provider-alias must be a lower-kebab scalar of at most 64 characters`,
      );
    }
    const runtimeMode = node["runtime-mode"] as unknown;
    if (
      runtimeMode !== undefined &&
      !RESOLVED_SESSION_RUNTIME_MODES.some(
        (candidate) => candidate === runtimeMode,
      )
    ) {
      throw new BlueprintValidationError(
        `Node ${JSON.stringify(node.id)} runtime-mode is invalid`,
      );
    }
    if (
      node.uses !== "wait" &&
      (providerAlias !== undefined || runtimeMode !== undefined)
    ) {
      throw new BlueprintValidationError(
        `Non-wait node ${JSON.stringify(node.id)} must not declare session selection`,
      );
    }
    if (node.uses !== "wait" && agentNameList !== undefined) {
      throw new BlueprintValidationError(
        `Non-wait node ${JSON.stringify(node.id)} must not assign an agent name`,
      );
    }
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
    const handoffTemplate = node["handoff-template"] as
      Record<string, unknown> | undefined;
    if (
      handoffTemplate !== undefined &&
      Object.hasOwn(handoffTemplate, "blobHash")
    ) {
      throw new BlueprintValidationError(
        `Agent wait node ${JSON.stringify(node.id)} uses removed handoff template field 'blobHash'; use 'commitSha'`,
      );
    }
    if (
      isAgentWait &&
      (node["handoff-template"] === undefined ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(
          node["handoff-template"].commitSha,
        ) ||
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
    const skills = node.skills as unknown;
    if (
      skills !== undefined &&
      (!Array.isArray(skills) ||
        skills.length === 0 ||
        skills.some(
          (skill) =>
            typeof skill !== "string" ||
            skill.length > 64 ||
            !/^[a-z]+(?:-[a-z]+)*$/.test(skill),
        ))
    ) {
      throw new BlueprintValidationError(
        `Node ${JSON.stringify(node.id)} skills must be a non-empty array of kebab-case names no longer than 64 characters`,
      );
    }
    if (Array.isArray(skills) && new Set(skills).size !== skills.length) {
      throw new BlueprintValidationError(
        `Node ${JSON.stringify(node.id)} skills must not contain duplicate names`,
      );
    }
    if (node.uses !== "wait" && skills !== undefined) {
      throw new BlueprintValidationError(
        `Non-wait node ${JSON.stringify(node.id)} must not declare skills`,
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
