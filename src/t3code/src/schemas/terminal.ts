// ---
// relationships:
//   implements:
//     - t3-code-client
//     - agent-tools
//     - node-types
// ---
import { z } from "zod";
import {
  ProviderInstanceId,
  TrimmedNonEmptyString,
  forwardCompatibleLiteral,
  taggedUnionWithUnknown,
} from "./common.js";

export const TerminalColsSchema = z.number().int().min(1).max(1000);
export type TerminalColsSchema = z.infer<typeof TerminalColsSchema>;
export const TerminalEnvKeySchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .max(128);
export type TerminalEnvKeySchema = z.infer<typeof TerminalEnvKeySchema>;
export const TerminalEnvValueSchema = z.string().max(8_192);
export type TerminalEnvValueSchema = z.infer<typeof TerminalEnvValueSchema>;
export const TerminalEnvSchema = z
  .record(TerminalEnvKeySchema, TerminalEnvValueSchema)
  .refine((value) => Object.keys(value).length <= 128);
export type TerminalEnvSchema = z.infer<typeof TerminalEnvSchema>;
export const TerminalRowsSchema = z.number().int().min(1).max(500);
export type TerminalRowsSchema = z.infer<typeof TerminalRowsSchema>;
export const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
export type TrimmedNonEmptyStringSchema = z.infer<typeof TrimmedNonEmptyStringSchema>;
export const TerminalIdSchema = TrimmedNonEmptyStringSchema.max(128);
export type TerminalIdSchema = z.infer<typeof TerminalIdSchema>;
export const TerminalThreadInput = z.looseObject({ threadId: TrimmedNonEmptyStringSchema });
export type TerminalThreadInput = z.infer<typeof TerminalThreadInput>;
export const TerminalSessionInput = z.looseObject({
  ...TerminalThreadInput.shape,
  terminalId: TerminalIdSchema,
});
export type TerminalSessionInput = z.infer<typeof TerminalSessionInput>;
export const TerminalOpenInput = z.looseObject({
  ...TerminalSessionInput.shape,
  cwd: TrimmedNonEmptyStringSchema,
  worktreePath: TrimmedNonEmptyStringSchema.nullable().optional(),
  cols: TerminalColsSchema.optional(),
  rows: TerminalRowsSchema.optional(),
  env: TerminalEnvSchema.optional(),
  providerInstanceId: ProviderInstanceId.optional(),
});
export type TerminalOpenInput = z.infer<typeof TerminalOpenInput>;
export const TerminalAttachInput = z.looseObject({
  ...TerminalSessionInput.shape,
  cwd: TrimmedNonEmptyStringSchema.optional(),
  worktreePath: TrimmedNonEmptyStringSchema.nullable().optional(),
  cols: TerminalColsSchema.optional(),
  rows: TerminalRowsSchema.optional(),
  env: TerminalEnvSchema.optional(),
  providerInstanceId: ProviderInstanceId.optional(),
  restartIfNotRunning: z.boolean().optional(),
});
export type TerminalAttachInput = z.infer<typeof TerminalAttachInput>;
export const TerminalWriteInput = z.looseObject({
  ...TerminalSessionInput.shape,
  data: z.string().min(1).max(65_536),
});
export type TerminalWriteInput = z.infer<typeof TerminalWriteInput>;
export const TerminalResizeInput = z.looseObject({
  ...TerminalSessionInput.shape,
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
});
export type TerminalResizeInput = z.infer<typeof TerminalResizeInput>;
export const TerminalCloseInput = z.looseObject({
  ...TerminalThreadInput.shape,
  terminalId: TerminalIdSchema.optional(),
  deleteHistory: z.boolean().optional(),
});
export type TerminalCloseInput = z.infer<typeof TerminalCloseInput>;
export const TerminalSessionStatus = forwardCompatibleLiteral([
  "starting",
  "running",
  "exited",
  "error",
]);
export type TerminalSessionStatus = z.infer<typeof TerminalSessionStatus>;
export const TerminalSessionSnapshot = z.looseObject({
  threadId: z.string().min(1),
  terminalId: z.string().min(1),
  cwd: z.string().min(1),
  worktreePath: TrimmedNonEmptyStringSchema.nullable(),
  status: TerminalSessionStatus,
  pid: z.number().int().gt(0).nullable(),
  history: z.string(),
  exitCode: z.number().int().nullable(),
  exitSignal: z.number().int().nullable(),
  label: z.string().max(128),
  updatedAt: z.string(),
  sequence: z.number().int().min(0).optional(),
});
export type TerminalSessionSnapshot = z.infer<typeof TerminalSessionSnapshot>;
export const TerminalEventBaseSchema = z.looseObject({
  threadId: z.string().min(1),
  terminalId: z.string().min(1),
  sequence: z.number().int().min(0).optional(),
});
export type TerminalEventBaseSchema = z.infer<typeof TerminalEventBaseSchema>;
export const TerminalActivityEvent = z.looseObject({
  ...TerminalEventBaseSchema.shape,
  type: z.literal("activity"),
  hasRunningSubprocess: z.boolean(),
  label: z.string().max(128),
});
export type TerminalActivityEvent = z.infer<typeof TerminalActivityEvent>;
export const TerminalClearedEvent = z.looseObject({
  ...TerminalEventBaseSchema.shape,
  type: z.literal("cleared"),
});
export type TerminalClearedEvent = z.infer<typeof TerminalClearedEvent>;
export const TerminalClosedEvent = z.looseObject({
  ...TerminalEventBaseSchema.shape,
  type: z.literal("closed"),
});
export type TerminalClosedEvent = z.infer<typeof TerminalClosedEvent>;
export const TerminalErrorEvent = z.looseObject({
  ...TerminalEventBaseSchema.shape,
  type: z.literal("error"),
  message: z.string().min(1),
});
export type TerminalErrorEvent = z.infer<typeof TerminalErrorEvent>;
export const TerminalExitedEvent = z.looseObject({
  ...TerminalEventBaseSchema.shape,
  type: z.literal("exited"),
  exitCode: z.number().int().nullable(),
  exitSignal: z.number().int().nullable(),
});
export type TerminalExitedEvent = z.infer<typeof TerminalExitedEvent>;
export const TerminalOutputEvent = z.looseObject({
  ...TerminalEventBaseSchema.shape,
  type: z.literal("output"),
  data: z.string(),
});
export type TerminalOutputEvent = z.infer<typeof TerminalOutputEvent>;
export const TerminalRestartedEvent = z.looseObject({
  ...TerminalEventBaseSchema.shape,
  type: z.literal("restarted"),
  snapshot: TerminalSessionSnapshot,
});
export type TerminalRestartedEvent = z.infer<typeof TerminalRestartedEvent>;
export const TerminalStartedEvent = z.looseObject({
  ...TerminalEventBaseSchema.shape,
  type: z.literal("started"),
  snapshot: TerminalSessionSnapshot,
});
export type TerminalStartedEvent = z.infer<typeof TerminalStartedEvent>;
export const TerminalEvent = taggedUnionWithUnknown("type", [
  TerminalStartedEvent,
  TerminalOutputEvent,
  TerminalExitedEvent,
  TerminalClosedEvent,
  TerminalErrorEvent,
  TerminalClearedEvent,
  TerminalRestartedEvent,
  TerminalActivityEvent,
]);
export type TerminalEvent = z.infer<typeof TerminalEvent>;
export const TerminalAttachSnapshotEvent = z.looseObject({
  type: z.literal("snapshot"),
  snapshot: TerminalSessionSnapshot,
});
export type TerminalAttachSnapshotEvent = z.infer<typeof TerminalAttachSnapshotEvent>;
export const TerminalAttachStreamEvent = taggedUnionWithUnknown("type", [
  TerminalAttachSnapshotEvent,
  TerminalOutputEvent,
  TerminalExitedEvent,
  TerminalClosedEvent,
  TerminalErrorEvent,
  TerminalClearedEvent,
  TerminalRestartedEvent,
  TerminalActivityEvent,
]);
export type TerminalAttachStreamEvent = z.infer<typeof TerminalAttachStreamEvent>;
