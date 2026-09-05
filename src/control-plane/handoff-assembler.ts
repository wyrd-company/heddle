// ---
// relationships:
//   implements: heddle
// ---

import type { JsonValue } from "../persistence/index.js";
import type { ReviewBasisDriftRemediationCause } from "./review-landing.js";

export type ReviewStageOutput = {
  findings: JsonValue[];
  transcript?: JsonValue;
};

export type StandardHandoffStage = {
  kind: "standard";
  name: string;
  priorStageOutputs: JsonValue[];
};

export type RemediationHandoffStage = {
  cause?: { kind: "review-findings" } | ReviewBasisDriftRemediationCause;
  kind: "remediation";
  name: string;
  review: ReviewStageOutput;
};

export type StageHandoffInput = {
  correlationToken: string;
  skillPointer: string;
  stage: RemediationHandoffStage | StandardHandoffStage;
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
  const stage: JsonValue =
    input.stage.kind === "remediation"
      ? {
          remediationCause: input.stage.cause ?? null,
          kind: input.stage.kind,
          name: input.stage.name,
          reviewFindings: input.stage.review.findings,
        }
      : {
          kind: input.stage.kind,
          name: input.stage.name,
          priorStageOutputs: input.stage.priorStageOutputs,
        };

  return canonicalJson({
    format: "heddle.stage-handoff",
    skillPointer: input.skillPointer,
    stage,
    taskContract: input.taskContract,
    todoList: input.todoList,
    version: 1,
  });
};
