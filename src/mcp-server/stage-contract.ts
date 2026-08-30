// ---
// relationships:
//   implements: heddle
// ---

import type { JsonValue } from "../persistence/index.js";
import type {
  WorkflowMcpDisposition,
  WorkflowMcpStageContract,
} from "./types.js";

const isDisposition = (value: JsonValue): value is WorkflowMcpDisposition =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  typeof value["name"] === "string" &&
  typeof value["description"] === "string" &&
  value["description"].trim() !== "";

export const isWorkflowMcpStageContract = (
  value: JsonValue,
): value is WorkflowMcpStageContract =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  typeof value["blueprintBlobHash"] === "string" &&
  typeof value["blueprintPath"] === "string" &&
  typeof value["handoffTemplate"] === "object" &&
  value["handoffTemplate"] !== null &&
  !Array.isArray(value["handoffTemplate"]) &&
  typeof value["handoffTemplate"]["blobHash"] === "string" &&
  typeof value["handoffTemplate"]["path"] === "string" &&
  typeof value["stage"] === "string" &&
  typeof value["todoTemplate"] === "string" &&
  Array.isArray(value["tools"]) &&
  value["tools"].every((tool) => typeof tool === "string") &&
  Array.isArray(value["dispositions"]) &&
  value["dispositions"].every(isDisposition);
