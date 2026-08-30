// ---
// relationships:
//   implements: heddle
// ---

import type { StageHandoffInput } from "../control-plane/index.js";
import {
  GitBlueprintStore,
  readCompletedStageOutputs,
  readLifecycleContext,
} from "../engine/index.js";
import { advanceOperationId } from "../mcp-server/operations.js";
import type { SqlitePersistence } from "../persistence/index.js";

export type ProductionHandoffStage = StageHandoffInput["stage"];
export type ProductionStageMetadata = {
  handoff: ProductionHandoffStage;
  repositoryName?: string;
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
  if (node.handoff === "standard") {
    return {
      handoff: {
        kind: "standard",
        name: input.stageId,
        priorStageOutputs: outputs.map(({ output }) => output),
      },
      ...(node.repo === undefined ? {} : { repositoryName: node.repo }),
    };
  }
  const review = outputs.at(-1)?.output;
  if (review === undefined || !Array.isArray(review["findings"])) {
    throw new Error(
      `Remediation stage ${JSON.stringify(input.stageId)} has no canonical review findings`,
    );
  }
  return {
    handoff: {
      kind: "remediation",
      name: input.stageId,
      review: {
        findings: review["findings"],
        ...(review["transcript"] === undefined
          ? {}
          : { transcript: review["transcript"] }),
      },
    },
    ...(node.repo === undefined ? {} : { repositoryName: node.repo }),
  };
};
