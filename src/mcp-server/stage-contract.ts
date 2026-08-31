// ---
// relationships:
//   implements: heddle
// ---

import type { JsonValue } from "../persistence/index.js";
import type {
  StoredWorkflowMcpDisposition,
  StoredWorkflowMcpStageContract,
} from "./types.js";

const isDisposition = (
  value: JsonValue,
): value is StoredWorkflowMcpDisposition =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  typeof value["name"] === "string" &&
  typeof value["description"] === "string" &&
  value["description"].trim() !== "" &&
  (value["outputContract"] === undefined ||
    value["outputContract"] === "optional" ||
    value["outputContract"] === "review-findings");

export const isWorkflowMcpStageContract = (
  value: JsonValue,
): value is StoredWorkflowMcpStageContract =>
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
