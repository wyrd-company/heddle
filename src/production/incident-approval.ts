// ---
// relationships:
//   implements: heddle
// ---

import { createHash } from "node:crypto";

import type {
  IncidentRuntimeRecord,
  JsonValue,
  SqlitePersistence,
} from "../persistence/index.js";
import {
  incidentSeverityLevels,
  type IncidentSeverity,
} from "./configuration.js";

type RecordValue = Record<string, JsonValue>;

export type IncidentProductionMutationApproval = {
  attentionId: string;
  incidentId: string;
  kind: "incident-production-mutation-approval";
  message: string;
  proposalDigest: string;
  taskId: number;
};

const asRecord = (value: JsonValue | undefined): RecordValue | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;

const canonical = (value: JsonValue): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export const incidentProposalDigest = (
  runtime: Pick<IncidentRuntimeRecord, "diagnosis">,
): string =>
  createHash("sha256")
    .update(canonical(runtime.diagnosis ?? null))
    .digest("hex");

export const incidentProposedActionKinds = (
  runtime: Pick<IncidentRuntimeRecord, "diagnosis">,
): Set<string> => {
  const actions = asRecord(runtime.diagnosis)?.["proposedActions"];
  return new Set(
    Array.isArray(actions)
      ? actions.flatMap((action) => {
          const kind = asRecord(action)?.["kind"];
          return typeof kind === "string" ? [kind] : [];
        })
      : [],
  );
};

export const incidentProductionMutationRequiresApproval = (
  runtime: Pick<IncidentRuntimeRecord, "diagnosis">,
  threshold: IncidentSeverity,
): boolean => {
  const actions = asRecord(runtime.diagnosis)?.["proposedActions"];
  if (!Array.isArray(actions)) return false;
  const thresholdIndex = incidentSeverityLevels.indexOf(threshold);
  return actions.some((action) => {
    const proposal = asRecord(action);
    if (proposal?.["kind"] !== "production-mutation") return false;
    const severity = proposal["severity"];
    if (
      typeof severity !== "string" ||
      !incidentSeverityLevels.includes(severity as IncidentSeverity)
    ) {
      return true;
    }
    return (
      incidentSeverityLevels.indexOf(severity as IncidentSeverity) >=
      thresholdIndex
    );
  });
};

export const incidentProductionMutationApproval = (
  runtime: IncidentRuntimeRecord,
): IncidentProductionMutationApproval => {
  const proposalDigest = incidentProposalDigest(runtime);
  return {
    attentionId: `incident-approval:${createHash("sha256")
      .update(`${runtime.incidentId}:${proposalDigest}`)
      .digest("hex")}`,
    incidentId: runtime.incidentId,
    kind: "incident-production-mutation-approval",
    message:
      "Approve the accepted incident proposal before a production-capable finalizer session starts",
    proposalDigest,
    taskId: runtime.taskId,
  };
};

export const incidentProductionMutationApproved = (
  persistence: SqlitePersistence,
  runtime: IncidentRuntimeRecord,
): boolean => {
  const proposalDigest = incidentProposalDigest(runtime);
  return persistence
    .replayEvents(runtime.incidentId)
    .some(
      ({ payload, type }) =>
        type === "operator:incident-production-mutation-approved" &&
        asRecord(payload)?.["proposalDigest"] === proposalDigest,
    );
};
