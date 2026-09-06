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

export const removedHandoffTemplateBlobHashDiagnostic = (
  value: JsonValue,
): string | undefined => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value["handoffTemplate"] !== "object" ||
    value["handoffTemplate"] === null ||
    Array.isArray(value["handoffTemplate"])
  ) {
    return undefined;
  }
  return Object.hasOwn(value["handoffTemplate"], "blobHash")
    ? "Workflow MCP stage contract uses removed handoff template field 'blobHash'; use 'commitSha'"
    : undefined;
};

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
  typeof value["handoffTemplate"]["commitSha"] === "string" &&
  /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(
    value["handoffTemplate"]["commitSha"],
  ) &&
  typeof value["handoffTemplate"]["path"] === "string" &&
  /^handoff-templates\/[a-z]+(?:-[a-z]+)*\.md$/.test(
    value["handoffTemplate"]["path"],
  ) &&
  Array.isArray(value["skills"]) &&
  value["skills"].every(
    (skill) =>
      typeof skill === "string" &&
      skill.length <= 64 &&
      /^[a-z]+(?:-[a-z]+)*$/.test(skill),
  ) &&
  new Set(value["skills"]).size === value["skills"].length &&
  typeof value["stage"] === "string" &&
  typeof value["todoTemplate"] === "string" &&
  Array.isArray(value["tools"]) &&
  value["tools"].every((tool) => typeof tool === "string") &&
  Array.isArray(value["dispositions"]) &&
  value["dispositions"].every(isDisposition);
