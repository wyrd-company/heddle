// ---
// relationships:
//   implements:
//     - t3-code-client
//     - agent-tools
//     - node-types
// ---
import { z } from "zod";
import { ServerAuthDescriptor } from "./auth.js";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  forwardCompatibleArray,
  forwardCompatibleLiteral,
  taggedUnionWithUnknown,
} from "./common.js";
import { ExecutionEnvironmentDescriptor } from "./environment.js";
import { ServerProviders, ServerProviderUsageLimits } from "./provider.js";

export const EditorId = forwardCompatibleLiteral(["cursor", "vscode", "zed", "file-manager"]);
export type EditorId = z.infer<typeof EditorId>;
export const EnvironmentTheme = z.looseObject({
  id: z.string(),
  name: z.string(),
  appearance: forwardCompatibleLiteral(["light", "dark"]),
});
export type EnvironmentTheme = z.infer<typeof EnvironmentTheme>;
export const FileManagerRevealKind = forwardCompatibleLiteral(["finder", "file-explorer", "files"]);
export type FileManagerRevealKind = z.infer<typeof FileManagerRevealKind>;
export const RemoteOpenTargetKind = forwardCompatibleLiteral(["tailscale", "mdns"]);
export type RemoteOpenTargetKind = z.infer<typeof RemoteOpenTargetKind>;
export const RemoteOpenTarget = z.looseObject({
  kind: RemoteOpenTargetKind,
  host: TrimmedNonEmptyString,
});
export type RemoteOpenTarget = z.infer<typeof RemoteOpenTarget>;
export const ResolvedKeybindingsConfig = z.array(z.looseObject({}));
export type ResolvedKeybindingsConfig = z.infer<typeof ResolvedKeybindingsConfig>;
export const ServerConfigIssues = z.array(z.looseObject({}));
export type ServerConfigIssues = z.infer<typeof ServerConfigIssues>;
export const ServerObservability = z.looseObject({});
export type ServerObservability = z.infer<typeof ServerObservability>;
export const ServerSettings = z.looseObject({});
export type ServerSettings = z.infer<typeof ServerSettings>;
export const UsageLimitSourceAccount = z.looseObject({
  id: TrimmedNonEmptyString,
  driver: TrimmedNonEmptyString,
  email: TrimmedNonEmptyString.optional(),
  plan: TrimmedNonEmptyString.optional(),
  usageLimits: ServerProviderUsageLimits,
});
export type UsageLimitSourceAccount = z.infer<typeof UsageLimitSourceAccount>;
export const UsageLimitSourceSnapshot = z.looseObject({
  id: TrimmedNonEmptyString,
  kind: forwardCompatibleLiteral(["cliproxy"]),
  label: TrimmedNonEmptyString,
  checkedAt: IsoDateTime,
  accounts: forwardCompatibleArray(UsageLimitSourceAccount),
  error: TrimmedNonEmptyString.optional(),
});
export type UsageLimitSourceSnapshot = z.infer<typeof UsageLimitSourceSnapshot>;
export const UsageLimitSourceSnapshots = forwardCompatibleArray(UsageLimitSourceSnapshot);
export type UsageLimitSourceSnapshots = z.infer<typeof UsageLimitSourceSnapshots>;
export const ServerConfig = z.looseObject({
  environment: ExecutionEnvironmentDescriptor,
  auth: ServerAuthDescriptor,
  cwd: TrimmedNonEmptyString,
  keybindingsConfigPath: TrimmedNonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
  providers: ServerProviders,
  availableEditors: forwardCompatibleArray(EditorId),
  remoteOpenTargets: forwardCompatibleArray(RemoteOpenTarget).optional(),
  observability: ServerObservability,
  settings: ServerSettings,
  shellResumeCompletionMarker: z.boolean().optional(),
  shellRevealInFileManager: z.boolean().optional(),
  shellRevealInFileManagerKind: FileManagerRevealKind.optional(),
  threadResumeCompletionMarker: z.boolean().optional(),
  threadSnapshotPagination: z.boolean().optional(),
  environmentThemes: z.array(EnvironmentTheme).optional(),
  usageLimitSources: UsageLimitSourceSnapshots.optional(),
});
export type ServerConfig = z.infer<typeof ServerConfig>;
export const ServerConfigEnvironmentThemesUpdatedPayload = z.looseObject({
  themes: z.array(EnvironmentTheme),
});
export type ServerConfigEnvironmentThemesUpdatedPayload = z.infer<
  typeof ServerConfigEnvironmentThemesUpdatedPayload
>;
export const ServerConfigStreamEnvironmentThemesUpdatedEvent = z.looseObject({
  version: z.literal(1),
  type: z.literal("environmentThemesUpdated"),
  payload: ServerConfigEnvironmentThemesUpdatedPayload,
});
export type ServerConfigStreamEnvironmentThemesUpdatedEvent = z.infer<
  typeof ServerConfigStreamEnvironmentThemesUpdatedEvent
>;
export const ServerConfigKeybindingsUpdatedPayload = z.looseObject({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerConfigKeybindingsUpdatedPayload = z.infer<
  typeof ServerConfigKeybindingsUpdatedPayload
>;
export const ServerConfigStreamKeybindingsUpdatedEvent = z.looseObject({
  version: z.literal(1),
  type: z.literal("keybindingsUpdated"),
  payload: ServerConfigKeybindingsUpdatedPayload,
});
export type ServerConfigStreamKeybindingsUpdatedEvent = z.infer<
  typeof ServerConfigStreamKeybindingsUpdatedEvent
>;
export const ServerConfigProviderStatusesPayload = z.looseObject({ providers: ServerProviders });
export type ServerConfigProviderStatusesPayload = z.infer<
  typeof ServerConfigProviderStatusesPayload
>;
export const ServerConfigStreamProviderStatusesEvent = z.looseObject({
  version: z.literal(1),
  type: z.literal("providerStatuses"),
  payload: ServerConfigProviderStatusesPayload,
});
export type ServerConfigStreamProviderStatusesEvent = z.infer<
  typeof ServerConfigStreamProviderStatusesEvent
>;
export const ServerConfigSettingsUpdatedPayload = z.looseObject({ settings: ServerSettings });
export type ServerConfigSettingsUpdatedPayload = z.infer<typeof ServerConfigSettingsUpdatedPayload>;
export const ServerConfigStreamSettingsUpdatedEvent = z.looseObject({
  version: z.literal(1),
  type: z.literal("settingsUpdated"),
  payload: ServerConfigSettingsUpdatedPayload,
});
export type ServerConfigStreamSettingsUpdatedEvent = z.infer<
  typeof ServerConfigStreamSettingsUpdatedEvent
>;
export const ServerConfigStreamSnapshotEvent = z.looseObject({
  version: z.literal(1),
  type: z.literal("snapshot"),
  config: ServerConfig,
});
export type ServerConfigStreamSnapshotEvent = z.infer<typeof ServerConfigStreamSnapshotEvent>;
export const ServerConfigUsageLimitSourcesUpdatedPayload = z.looseObject({
  sources: UsageLimitSourceSnapshots,
});
export type ServerConfigUsageLimitSourcesUpdatedPayload = z.infer<
  typeof ServerConfigUsageLimitSourcesUpdatedPayload
>;
export const ServerConfigStreamUsageLimitSourcesUpdatedEvent = z.looseObject({
  version: z.literal(1),
  type: z.literal("usageLimitSourcesUpdated"),
  payload: ServerConfigUsageLimitSourcesUpdatedPayload,
});
export type ServerConfigStreamUsageLimitSourcesUpdatedEvent = z.infer<
  typeof ServerConfigStreamUsageLimitSourcesUpdatedEvent
>;
export const ServerConfigStreamEvent = taggedUnionWithUnknown("type", [
  ServerConfigStreamSnapshotEvent,
  ServerConfigStreamKeybindingsUpdatedEvent,
  ServerConfigStreamProviderStatusesEvent,
  ServerConfigStreamSettingsUpdatedEvent,
  ServerConfigStreamEnvironmentThemesUpdatedEvent,
  ServerConfigStreamUsageLimitSourcesUpdatedEvent,
]);
export type ServerConfigStreamEvent = z.infer<typeof ServerConfigStreamEvent>;
export const ServerSelfUpdateOutcome = z.looseObject({
  id: TrimmedNonEmptyString,
  fromVersion: TrimmedNonEmptyString,
  targetVersion: TrimmedNonEmptyString,
  status: forwardCompatibleLiteral(["committed", "rolled-back", "failed"]),
  reason: TrimmedNonEmptyString.optional(),
});
export type ServerSelfUpdateOutcome = z.infer<typeof ServerSelfUpdateOutcome>;
export const ServerLifecycleReadyPayload = z.looseObject({
  at: IsoDateTime,
  environment: ExecutionEnvironmentDescriptor,
  updateOutcome: ServerSelfUpdateOutcome.optional(),
});
export type ServerLifecycleReadyPayload = z.infer<typeof ServerLifecycleReadyPayload>;
export const ServerLifecycleStreamReadyEvent = z.looseObject({
  version: z.literal(1),
  sequence: NonNegativeInt,
  type: z.literal("ready"),
  payload: ServerLifecycleReadyPayload,
});
export type ServerLifecycleStreamReadyEvent = z.infer<typeof ServerLifecycleStreamReadyEvent>;
export const ServerLifecycleWelcomePayload = z.looseObject({
  environment: ExecutionEnvironmentDescriptor,
  cwd: TrimmedNonEmptyString,
  projectName: TrimmedNonEmptyString,
  bootstrapStatus: forwardCompatibleLiteral(["pending", "complete"]).optional(),
  bootstrapProjectId: ProjectId.optional(),
  bootstrapThreadId: ThreadId.optional(),
  bootstrapProjectCreated: z.boolean().optional(),
  bootstrapThreadCreated: z.boolean().optional(),
});
export type ServerLifecycleWelcomePayload = z.infer<typeof ServerLifecycleWelcomePayload>;
export const ServerLifecycleStreamWelcomeEvent = z.looseObject({
  version: z.literal(1),
  sequence: NonNegativeInt,
  type: z.literal("welcome"),
  payload: ServerLifecycleWelcomePayload,
});
export type ServerLifecycleStreamWelcomeEvent = z.infer<typeof ServerLifecycleStreamWelcomeEvent>;
export const ServerLifecycleStreamEvent = taggedUnionWithUnknown("type", [
  ServerLifecycleStreamWelcomeEvent,
  ServerLifecycleStreamReadyEvent,
]);
export type ServerLifecycleStreamEvent = z.infer<typeof ServerLifecycleStreamEvent>;
export const ServerProviderUpdatedPayload = z.looseObject({ providers: ServerProviders });
export type ServerProviderUpdatedPayload = z.infer<typeof ServerProviderUpdatedPayload>;

export { ServerProvider, ServerProviders } from "./provider.js";
