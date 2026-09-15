// ---
// relationships:
//   implements: heddle
// ---

import type { StageHandoffInput } from "../control-plane/index.js";
import {
  GitBlueprintStore,
  lifecycleProjectionOf,
  readCompletedStageOutputs,
  readLifecycleContext,
  type LifecycleBlueprint,
} from "../engine/index.js";
import { advanceOperationId } from "../mcp-server/operations.js";
import type {
  JsonValue,
  SessionRuntimeRecord,
  SqlitePersistence,
} from "../persistence/index.js";
import type { ResolvedSessionRuntimeMode } from "../persistence/index.js";
import type { AgentNameListName } from "../agent-names/index.js";

export type ProductionHandoffStage = StageHandoffInput["stage"];
export type ProductionStageMetadata = {
  agentNameList?: AgentNameListName;
  handoff: ProductionHandoffStage;
  providerAlias?: string;
  /** The stage's effort, or the blueprint header's when the stage sets none. */
  reasoningEffort?: string;
  /** Which layer set `reasoningEffort`, so a refusal can name it. */
  reasoningEffortOrigin?: "lifecycle-header" | "stage";
  repositoryName?: string;
  runtimeMode?: ResolvedSessionRuntimeMode;
};

/**
 * How a refusal names the layer that set the effort. The operator needs to
 * know which document to edit, and the two layers live in different places.
 */
export const reasoningEffortOriginLabel = (
  stage: Pick<ProductionStageMetadata, "reasoningEffortOrigin">,
  stageId: string,
): string | undefined =>
  stage.reasoningEffortOrigin === undefined
    ? undefined
    : stage.reasoningEffortOrigin === "stage"
      ? `Stage '${stageId}'`
      : "The lifecycle header";

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
  if (node?.uses !== "wait") {
    throw new Error(
      `Stage ${JSON.stringify(input.stageId)} has no valid handoff metadata`,
    );
  }
  const completedStages = input.persistence
    .listSessionRuntime()
    .filter(
      (session): session is SessionRuntimeRecord & { kind: "stage" } =>
        session.kind === "stage" && session.instanceId === input.instanceId,
    )
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
  // The node that finished last is the one whose edge routed the lifecycle
  // into this stage; its output is what the stage was handed.
  // The narrowest layer wins: the stage's own effort, then the lifecycle
  // header's, then whatever the resolved alias carries.
  const reasoningEffort =
    node["reasoning-effort"] ?? blueprint["reasoning-effort"];
  const reasoningEffortOrigin =
    node["reasoning-effort"] === undefined ? "lifecycle-header" : "stage";
  const projection = lifecycleProjectionOf(context);
  const entry =
    projection.current === null
      ? null
      : {
          node: projection.current.node,
          output: projection.outputs[projection.current.node] ?? null,
        };
  return {
    ...(node["assign-agent-name"] === undefined
      ? {}
      : { agentNameList: node["assign-agent-name"] }),
    handoff: {
      entry,
      name: input.stageId,
      priorStageOutputs: [
        ...outputs.map(({ output }) => output),
        ...mechanicalOutputs,
      ],
      skills: node.skills ?? [],
    },
    ...(node["provider-alias"] === undefined
      ? {}
      : { providerAlias: node["provider-alias"] }),
    ...(reasoningEffort === undefined
      ? {}
      : { reasoningEffort, reasoningEffortOrigin }),
    ...(node.repo === undefined ? {} : { repositoryName: node.repo }),
    ...(node["runtime-mode"] === undefined
      ? {}
      : { runtimeMode: node["runtime-mode"] }),
  };
};
