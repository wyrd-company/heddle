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
  "driverKind",
  "interactionMode",
  "modelSlug",
  "observedCliVersion",
  "providerDisplayName",
  "providerInstanceId",
  "runtimeMode",
  "sessionKey",
  "threadId",
] as const;

export function isResolvedSessionBinding(
  value: unknown,
): value is ResolvedSessionBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const binding = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(binding).sort()) !==
    JSON.stringify(resolvedSessionBindingFields)
  ) {
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
  return resolvedSessionBindingFields
    .filter((field) => field !== "observedCliVersion")
    .every(
      (field) =>
        typeof binding[field] === "string" && binding[field].trim() !== "",
    );
}

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
  resolvedSessionBindingFields.every((field) => left[field] === right[field]);
