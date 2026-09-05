// ---
// relationships:
//   implements: heddle
// ---

import type { FlowcraftEvent } from "flowcraft";

import type {
  ReviewBasisDriftRemediationCause,
  StageHandoffInput,
} from "../control-plane/index.js";
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

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const reviewObjectId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

const nullableReviewObjectId = (value: unknown): value is string | null =>
  value === null || reviewObjectId(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

const reviewBasisDriftCause = (
  value: unknown,
): ReviewBasisDriftRemediationCause | undefined => {
  const candidate = asRecord(value);
  if (
    candidate?.["kind"] !== "review-basis-drift" ||
    !/^[0-9A-Z]+$/.test(String(candidate["snapshotId"] ?? "")) ||
    !nonEmptyString(candidate["sourceBranch"]) ||
    !nonEmptyString(candidate["targetBranch"]) ||
    !reviewObjectId(candidate["reviewedSourceHead"]) ||
    !reviewObjectId(candidate["reviewedBaseHead"]) ||
    !nullableReviewObjectId(candidate["currentSourceHead"]) ||
    !nullableReviewObjectId(candidate["currentTargetHead"])
  ) {
    return undefined;
  }
  return candidate as ReviewBasisDriftRemediationCause;
};

const reviewBasisDriftCauseFromMechanicalOutput = (
  value: unknown,
): ReviewBasisDriftRemediationCause | undefined => {
  const output = asRecord(value);
  const dispositions = asRecord(output?.["dispositions"]);
  const cause = reviewBasisDriftCause(output?.["remediationCause"]);
  return cause !== undefined &&
    output?.["alreadyMerged"] === false &&
    output["merged"] === false &&
    dispositions?.["merged"] === false &&
    dispositions["remediate"] === true &&
    output["snapshotId"] === cause.snapshotId
    ? cause
    : undefined;
};

const currentMechanicalOutputsForStage = async (
  blueprint: LifecycleBlueprint,
  persistence: SqlitePersistence,
  serializedContext: string | null,
  stageId: string,
): Promise<unknown[]> => {
  if (serializedContext === null) return [];
  const serialized = asRecord(JSON.parse(serializedContext) as unknown);
  const executionId = serialized?.["_executionId"];
  if (!nonEmptyString(executionId)) return [];
  const nodesById = new Map(blueprint.nodes.map((node) => [node.id, node]));
  const directMechanicalPredecessors = new Set(
    blueprint.edges.flatMap((edge) => {
      const source = nodesById.get(edge.source);
      return edge.target === stageId &&
        source !== undefined &&
        source.uses !== "wait"
        ? [edge.source]
        : [];
    }),
  );
  const events = (await persistence.flowcraftHistory.replay(
    executionId,
  )) as FlowcraftEvent[];
  return events.flatMap((event) =>
    event.type === "node:finish" &&
    directMechanicalPredecessors.has(event.payload.nodeId)
      ? [event.payload.result.output]
      : [],
  );
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
  const currentMechanicalOutputs = await currentMechanicalOutputsForStage(
    blueprint,
    input.persistence,
    context.serializedContext,
    input.stageId,
  );
  const driftCause = currentMechanicalOutputs
    .map(reviewBasisDriftCauseFromMechanicalOutput)
    .find((cause) => cause !== undefined);
  const priorStage = outputs.at(-1);
  const review = priorStage?.output;
  const reviewFindings =
    review !== undefined && Array.isArray(review["findings"])
      ? review["findings"]
      : undefined;
  const hasReviewFindings = reviewFindings !== undefined;
  const findings =
    driftCause === undefined && hasReviewFindings ? reviewFindings : [];
  return {
    ...(driftCause !== undefined || hasReviewFindings
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
      ...(driftCause === undefined
        ? hasReviewFindings
          ? { cause: { kind: "review-findings" as const } }
          : {}
        : { cause: driftCause }),
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
