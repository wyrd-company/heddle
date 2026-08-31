// ---
// relationships:
//   implements: heddle
// ---

import type { StageHandoffInput } from "../control-plane/index.js";
import {
  GitBlueprintStore,
  readCompletedStageOutputs,
  readLifecycleContext,
  type LifecycleBlueprint,
} from "../engine/index.js";
import { advanceOperationId } from "../mcp-server/operations.js";
import type { JsonValue, SqlitePersistence } from "../persistence/index.js";

export type ProductionHandoffStage = StageHandoffInput["stage"];
export type ProductionHandoffContractIssue = {
  field: "findings";
  priorStageId?: string;
};
export type ProductionStageMetadata = {
  contractIssue?: ProductionHandoffContractIssue;
  handoff: ProductionHandoffStage;
  repositoryName?: string;
};

const mechanicalOutputsForStage = (
  blueprint: LifecycleBlueprint,
  serializedContext: string | null,
  stageId: string,
): JsonValue[] => {
  if (serializedContext === null) return [];
  const serialized = JSON.parse(serializedContext) as unknown;
  if (
    typeof serialized !== "object" ||
    serialized === null ||
    Array.isArray(serialized)
  ) {
    throw new Error("Serialized lifecycle context must be an object");
  }
  const context = serialized as Record<string, unknown>;
  const nodesById = new Map(blueprint.nodes.map((node) => [node.id, node]));
  const mechanicalIds = new Set<string>();
  const pending = [stageId];
  while (pending.length > 0) {
    const target = pending.pop();
    if (target === undefined) continue;
    for (const edge of blueprint.edges.filter(
      ({ target: edgeTarget }) => edgeTarget === target,
    )) {
      const source = nodesById.get(edge.source);
      if (source === undefined || source.uses === "wait") continue;
      if (mechanicalIds.has(source.id)) continue;
      mechanicalIds.add(source.id);
      pending.push(source.id);
    }
  }
  return blueprint.nodes.flatMap(({ id }) => {
    const key = `_outputs.${id}`;
    return mechanicalIds.has(id) && Object.hasOwn(context, key)
      ? [context[key] as JsonValue]
      : [];
  });
};

export const readProductionHandoffStage = async (input: {
  instanceId: string;
  persistence: SqlitePersistence;
  repositoryRoot: string;
  stageId: string;
}): Promise<ProductionStageMetadata> => {
  const record = input.persistence.getInstance(input.instanceId);
  if (record === undefined) {
    throw new Error(`Instance does not exist: ${input.instanceId}`);
  }
  const context = readLifecycleContext(record);
  const blueprint = await new GitBlueprintStore(input.repositoryRoot).read(
    context.blueprintBlobHash,
    context.blueprintPath,
  );
  const node = blueprint.nodes.find(({ id }) => id === input.stageId);
  if (
    node?.uses !== "wait" ||
    (node.handoff !== "standard" && node.handoff !== "remediation")
  ) {
    throw new Error(
      `Stage ${JSON.stringify(input.stageId)} has no valid handoff metadata`,
    );
  }
  const completedStages = input.persistence
    .listSessionRuntime()
    .filter((session) => session.instanceId === input.instanceId)
    .flatMap((session) => {
      const operation =
        context.completedOperations[advanceOperationId(session.sessionKey)];
      return operation === undefined
        ? []
        : [{ operation, stageId: session.stageId }];
    });
  const outputs = await readCompletedStageOutputs(
    input.persistence,
    context,
    completedStages,
  );
  const mechanicalOutputs = mechanicalOutputsForStage(
    blueprint,
    context.serializedContext,
    input.stageId,
  );
  if (node.handoff === "standard") {
    return {
      handoff: {
        kind: "standard",
        name: input.stageId,
        priorStageOutputs: [
          ...outputs.map(({ output }) => output),
          ...mechanicalOutputs,
        ],
      },
      ...(node.repo === undefined ? {} : { repositoryName: node.repo }),
    };
  }
  const priorStage = outputs.at(-1);
  const review = priorStage?.output;
  const findings =
    review !== undefined && Array.isArray(review["findings"])
      ? review["findings"]
      : [];
  return {
    ...(review !== undefined && Array.isArray(review["findings"])
      ? {}
      : {
          contractIssue: {
            field: "findings" as const,
            ...(priorStage === undefined
              ? {}
              : { priorStageId: priorStage.stageId }),
          },
        }),
    handoff: {
      kind: "remediation",
      name: input.stageId,
      review: {
        findings,
        ...(review?.["transcript"] === undefined
          ? {}
          : { transcript: review["transcript"] }),
      },
    },
    ...(node.repo === undefined ? {} : { repositoryName: node.repo }),
  };
};
