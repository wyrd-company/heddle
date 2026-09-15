// ---
// relationships:
//   implements: heddle
// ---

import type { JsonValue } from "../persistence/index.js";

/** The node whose finish routed the lifecycle into this stage, and its output. */
export type HandoffStageEntry = {
  node: string;
  output: JsonValue;
};

export type HandoffStage = {
  agentName?: string;
  entry?: HandoffStageEntry | null;
  name: string;
  priorStageOutputs: JsonValue[];
  skills?: string[];
};

export type StageHandoffInput = {
  correlationToken: string;
  stage: HandoffStage;
  taskContract: JsonValue;
  todoList: JsonValue;
};

export const canonicalJson = (value: JsonValue): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
};

export const assembleStageHandoff = (input: StageHandoffInput): string => {
  const stage: JsonValue = {
    ...(input.stage.agentName === undefined
      ? {}
      : { agentName: input.stage.agentName }),
    entry: input.stage.entry ?? null,
    name: input.stage.name,
    priorStageOutputs: input.stage.priorStageOutputs,
    skills: input.stage.skills ?? [],
  };

  return canonicalJson({
    format: "heddle.stage-handoff",
    stage,
    taskContract: input.taskContract,
    todoList: input.todoList,
    version: 1,
  });
};
