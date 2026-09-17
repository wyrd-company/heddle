// ---
// relationships:
//   implements:
//     - t3-code-client
//     - agent-tools
//     - node-types
// ---
import { z } from "zod";
import {
  IsoDateTime,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
  forwardCompatibleArray,
  forwardCompatibleLiteral,
  taggedUnionWithUnknown,
} from "./common.js";
export const RuntimeMode = forwardCompatibleLiteral([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
export type RuntimeMode = z.infer<typeof RuntimeMode>;

export const ProviderSessionStatus = forwardCompatibleLiteral([
  "connecting",
  "ready",
  "running",
  "error",
  "closed",
]);
export type ProviderSessionStatus = z.infer<typeof ProviderSessionStatus>;
export const ProviderSession = z.looseObject({
  provider: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId.optional(),
  status: ProviderSessionStatus,
  runtimeMode: RuntimeMode,
  cwd: TrimmedNonEmptyString.optional(),
  model: TrimmedNonEmptyString.optional(),
  threadId: ThreadId,
  resumeCursor: z.unknown().optional(),
  activeTurnId: TurnId.optional(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastError: TrimmedNonEmptyString.optional(),
});
export type ProviderSession = z.infer<typeof ProviderSession>;
export const ProviderOptionDescriptorBase = {
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString.optional(),
};
export const BooleanProviderOptionDescriptor = z.looseObject({
  ...ProviderOptionDescriptorBase,
  type: z.literal("boolean"),
  currentValue: z.boolean().optional(),
});
export type BooleanProviderOptionDescriptor = z.infer<typeof BooleanProviderOptionDescriptor>;
export const ProviderOptionChoice = z.looseObject({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString.optional(),
  isDefault: z.boolean().optional(),
});
export type ProviderOptionChoice = z.infer<typeof ProviderOptionChoice>;
export const SelectProviderOptionDescriptor = z.looseObject({
  ...ProviderOptionDescriptorBase,
  type: z.literal("select"),
  options: z.array(ProviderOptionChoice),
  currentValue: TrimmedNonEmptyString.optional(),
  promptInjectedValues: z.array(TrimmedNonEmptyString).optional(),
});
export type SelectProviderOptionDescriptor = z.infer<typeof SelectProviderOptionDescriptor>;
export const ProviderOptionDescriptor = taggedUnionWithUnknown("type", [
  SelectProviderOptionDescriptor,
  BooleanProviderOptionDescriptor,
]);
export type ProviderOptionDescriptor = z.infer<typeof ProviderOptionDescriptor>;
export const ModelCapabilities = z.looseObject({
  optionDescriptors: z.array(ProviderOptionDescriptor).optional(),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilities>;
export const ProviderOptionSelectionValue = z.union([TrimmedNonEmptyString, z.boolean()]);
export type ProviderOptionSelectionValue = z.infer<typeof ProviderOptionSelectionValue>;
export const ProviderOptionSelection = z.looseObject({
  id: TrimmedNonEmptyString,
  value: ProviderOptionSelectionValue,
});
export type ProviderOptionSelection = z.infer<typeof ProviderOptionSelection>;
export const ProviderOptionSelections = z.union([
  z.array(ProviderOptionSelection),
  z.record(z.string(), z.unknown()).transform((value) =>
    Object.entries(value).flatMap(([key, raw]): Array<{ id: string; value: string | boolean }> => {
      const id = key.trim();
      if (!id) return [];
      if (typeof raw === "boolean") return [{ id, value: raw }];
      if (typeof raw === "string" && raw.trim()) return [{ id, value: raw.trim() }];
      return [];
    }),
  ),
]);
export type ProviderOptionSelections = z.infer<typeof ProviderOptionSelections>;
export const ServerProviderAuthStatus = forwardCompatibleLiteral([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type ServerProviderAuthStatus = z.infer<typeof ServerProviderAuthStatus>;
export const ServerProviderAuth = z.looseObject({
  status: ServerProviderAuthStatus,
  type: TrimmedNonEmptyString.optional(),
  label: TrimmedNonEmptyString.optional(),
  email: TrimmedNonEmptyString.optional(),
});
export type ServerProviderAuth = z.infer<typeof ServerProviderAuth>;
export const ServerProviderAvailability = forwardCompatibleLiteral(["available", "unavailable"]);
export type ServerProviderAvailability = z.infer<typeof ServerProviderAvailability>;
export const ServerProviderContinuation = z.looseObject({ groupKey: TrimmedNonEmptyString });
export type ServerProviderContinuation = z.infer<typeof ServerProviderContinuation>;
export const ServerProviderModel = z.looseObject({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  shortName: TrimmedNonEmptyString.optional(),
  subProvider: TrimmedNonEmptyString.optional(),
  aliases: z.array(TrimmedNonEmptyString).optional(),
  badge: forwardCompatibleLiteral(["new"]).optional(),
  isCustom: z.boolean(),
  isDefault: z.boolean().optional(),
  isLegacy: z.boolean().optional(),
  capabilities: ModelCapabilities.nullable(),
});
export type ServerProviderModel = z.infer<typeof ServerProviderModel>;
export const ServerProviderSkill = z.looseObject({
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString.optional(),
  path: TrimmedNonEmptyString,
  scope: TrimmedNonEmptyString.optional(),
  enabled: z.boolean(),
  displayName: TrimmedNonEmptyString.optional(),
  shortDescription: TrimmedNonEmptyString.optional(),
  userInvocationOnly: z.boolean().optional(),
  userInvocable: z.boolean().optional(),
});
export type ServerProviderSkill = z.infer<typeof ServerProviderSkill>;
export const ServerProviderSlashCommandInput = z.looseObject({ hint: TrimmedNonEmptyString });
export type ServerProviderSlashCommandInput = z.infer<typeof ServerProviderSlashCommandInput>;
export const ServerProviderSlashCommand = z.looseObject({
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString.optional(),
  input: ServerProviderSlashCommandInput.optional(),
});
export type ServerProviderSlashCommand = z.infer<typeof ServerProviderSlashCommand>;
export const ServerProviderState = forwardCompatibleLiteral([
  "ready",
  "warning",
  "error",
  "disabled",
]);
export type ServerProviderState = z.infer<typeof ServerProviderState>;
export const ServerProviderUpdateStatus = forwardCompatibleLiteral([
  "idle",
  "queued",
  "running",
  "succeeded",
  "failed",
  "unchanged",
]);
export type ServerProviderUpdateStatus = z.infer<typeof ServerProviderUpdateStatus>;
export const ServerProviderUpdateState = z.looseObject({
  status: ServerProviderUpdateStatus,
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
  message: TrimmedNonEmptyString.nullable(),
  output: z.string().max(10_000).nullable(),
});
export type ServerProviderUpdateState = z.infer<typeof ServerProviderUpdateState>;
export const ServerProviderUsageWindow = z.looseObject({
  id: TrimmedNonEmptyString,
  kind: forwardCompatibleLiteral(["session", "weekly", "monthly", "other"]),
  label: TrimmedNonEmptyString,
  usedPercent: z.number().min(0).max(100),
  resetsAt: IsoDateTime.optional(),
  windowDurationMins: z.number().int().nonnegative().optional(),
});
export type ServerProviderUsageWindow = z.infer<typeof ServerProviderUsageWindow>;
export const ServerProviderResetCredits = z.looseObject({
  availableCount: z.number().int().nonnegative(),
  nextExpiresAt: IsoDateTime.optional(),
  nextCreditId: TrimmedNonEmptyString.optional(),
});
export type ServerProviderResetCredits = z.infer<typeof ServerProviderResetCredits>;
export const ServerProviderUsageLimits = z.looseObject({
  checkedAt: IsoDateTime,
  windows: forwardCompatibleArray(ServerProviderUsageWindow),
  resetCredits: ServerProviderResetCredits.optional(),
  unavailable: z
    .looseObject({
      reason: forwardCompatibleLiteral(["unsupported", "probeFailed"]),
      message: TrimmedNonEmptyString.optional(),
    })
    .optional(),
});
export type ServerProviderUsageLimits = z.infer<typeof ServerProviderUsageLimits>;
export const ServerProviderVersionAdvisoryStatus = forwardCompatibleLiteral([
  "unknown",
  "current",
  "behind_latest",
]);
export type ServerProviderVersionAdvisoryStatus = z.infer<
  typeof ServerProviderVersionAdvisoryStatus
>;
export const ServerProviderVersionAdvisory = z.looseObject({
  status: ServerProviderVersionAdvisoryStatus,
  currentVersion: TrimmedNonEmptyString.nullable(),
  latestVersion: TrimmedNonEmptyString.nullable(),
  updateCommand: TrimmedNonEmptyString.nullable(),
  canUpdate: z.boolean().default(false),
  checkedAt: IsoDateTime.nullable(),
  message: TrimmedNonEmptyString.nullable(),
});
export type ServerProviderVersionAdvisory = z.infer<typeof ServerProviderVersionAdvisory>;
export const ServerProviderWorkspaceSnapshot = z.looseObject({
  cwd: TrimmedNonEmptyString,
  checkedAt: IsoDateTime,
  slashCommands: z.array(ServerProviderSlashCommand),
  skills: z.array(ServerProviderSkill),
});
export type ServerProviderWorkspaceSnapshot = z.infer<typeof ServerProviderWorkspaceSnapshot>;
export const ServerProvider = z.looseObject({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: TrimmedNonEmptyString.optional(),
  accentColor: TrimmedNonEmptyString.optional(),
  badgeLabel: TrimmedNonEmptyString.optional(),
  continuation: ServerProviderContinuation.optional(),
  showInteractionModeToggle: z.boolean().optional(),
  reportsContextWindow: z.boolean().optional(),
  requiresNewThreadForModelChange: z.boolean().optional(),
  supportsConversationRollback: z.boolean().optional(),
  supportsTextGeneration: z.boolean().optional(),
  setup: z.looseObject({ canAuthenticate: z.boolean(), canInstall: z.boolean() }).optional(),
  enabled: z.boolean(),
  installed: z.boolean(),
  version: TrimmedNonEmptyString.nullable(),
  status: ServerProviderState,
  auth: ServerProviderAuth,
  checkedAt: IsoDateTime,
  message: TrimmedNonEmptyString.optional(),
  availability: ServerProviderAvailability.optional(),
  unavailableReason: TrimmedNonEmptyString.optional(),
  models: z.array(ServerProviderModel),
  slashCommands: z.array(ServerProviderSlashCommand).default([]),
  skills: z.array(ServerProviderSkill).default([]),
  workspaceSnapshots: z.array(ServerProviderWorkspaceSnapshot).optional(),
  usageLimits: ServerProviderUsageLimits.optional(),
  versionAdvisory: ServerProviderVersionAdvisory.optional(),
  updateState: ServerProviderUpdateState.optional(),
});
export type ServerProvider = z.infer<typeof ServerProvider>;
export const ServerProviders = forwardCompatibleArray(ServerProvider);
export type ServerProviders = z.infer<typeof ServerProviders>;

export { ProviderInstanceId, ProviderDriverKind } from "./common.js";
