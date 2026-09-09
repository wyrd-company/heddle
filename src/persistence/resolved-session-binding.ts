// ---
// relationships:
//   implements: heddle
// ---

import {
  RESOLVED_SESSION_RUNTIME_MODES,
  type ResolvedSessionBinding,
} from "./types.js";

export const resolvedSessionBindingFields = [
  "alias",
  "candidatePosition",
  "driverKind",
  "interactionMode",
  "modelSlug",
  "observedCliVersion",
  "providerDisplayName",
  "providerInstanceId",
  "runtimeMode",
  "sessionKey",
  "skippedCandidates",
  "threadId",
] as const;

const legacyResolvedSessionBindingFields = resolvedSessionBindingFields.filter(
  (field) => field !== "candidatePosition" && field !== "skippedCandidates",
);

const sameFields = (
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean =>
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify(fields);

const isFailureDetail = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const detail = value as Record<string, unknown>;
  return (
    sameFields(detail, ["cause", "message", "name"]) &&
    typeof detail["message"] === "string" &&
    detail["message"].trim() !== "" &&
    typeof detail["name"] === "string" &&
    detail["name"].trim() !== "" &&
    (detail["cause"] === null || isFailureDetail(detail["cause"]))
  );
};

const isSkippedCandidate = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    sameFields(candidate, [
      "candidatePosition",
      "failure",
      "modelSlug",
      "providerDisplayName",
    ]) &&
    Number.isSafeInteger(candidate["candidatePosition"]) &&
    (candidate["candidatePosition"] as number) > 0 &&
    isFailureDetail(candidate["failure"]) &&
    typeof candidate["modelSlug"] === "string" &&
    candidate["modelSlug"].trim() !== "" &&
    typeof candidate["providerDisplayName"] === "string" &&
    candidate["providerDisplayName"].trim() !== ""
  );
};

export function isResolvedSessionBinding(
  value: unknown,
): value is ResolvedSessionBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const binding = value as Record<string, unknown>;
  if (!sameFields(binding, resolvedSessionBindingFields)) {
    return false;
  }
  if (
    !RESOLVED_SESSION_RUNTIME_MODES.includes(
      binding["runtimeMode"] as ResolvedSessionBinding["runtimeMode"],
    )
  ) {
    return false;
  }
  if (
    binding["observedCliVersion"] !== null &&
    (typeof binding["observedCliVersion"] !== "string" ||
      binding["observedCliVersion"].trim() === "")
  ) {
    return false;
  }
  if (
    !Number.isSafeInteger(binding["candidatePosition"]) ||
    (binding["candidatePosition"] as number) <= 0 ||
    !Array.isArray(binding["skippedCandidates"]) ||
    !binding["skippedCandidates"].every(isSkippedCandidate)
  ) {
    return false;
  }
  return resolvedSessionBindingFields
    .filter(
      (field) =>
        field !== "candidatePosition" &&
        field !== "observedCliVersion" &&
        field !== "skippedCandidates",
    )
    .every(
      (field) =>
        typeof binding[field] === "string" && binding[field].trim() !== "",
    );
}

export const normalizeResolvedSessionBinding = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const binding = value as Record<string, unknown>;
  if (!sameFields(binding, legacyResolvedSessionBindingFields)) return value;
  return { ...binding, candidatePosition: 1, skippedCandidates: [] };
};

export function assertResolvedSessionBinding(
  value: unknown,
  sessionKey: string,
  threadId: string,
): asserts value is ResolvedSessionBinding {
  if (!isResolvedSessionBinding(value)) {
    throw new TypeError("binding has an invalid non-secret field set");
  }
  if (value.sessionKey !== sessionKey || value.threadId !== threadId) {
    throw new Error(
      "Resolved session binding changed its session or thread identity",
    );
  }
}

export const sameResolvedSessionBinding = (
  left: ResolvedSessionBinding,
  right: ResolvedSessionBinding,
): boolean =>
  resolvedSessionBindingFields.every((field) =>
    field === "skippedCandidates"
      ? JSON.stringify(left[field]) === JSON.stringify(right[field])
      : left[field] === right[field],
  );
