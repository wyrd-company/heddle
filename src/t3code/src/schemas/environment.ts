import { z } from "zod";

import { EnvironmentId, TrimmedNonEmptyString } from "./common.js";

export const ExecutionEnvironmentPlatformOs = z.enum(["darwin", "linux", "windows", "unknown"]);
export type ExecutionEnvironmentPlatformOs = z.infer<typeof ExecutionEnvironmentPlatformOs>;

export const ExecutionEnvironmentPlatformArch = z.enum(["arm64", "x64", "other"]);
export type ExecutionEnvironmentPlatformArch = z.infer<typeof ExecutionEnvironmentPlatformArch>;

export const ExecutionEnvironmentPlatform = z.looseObject({
  os: ExecutionEnvironmentPlatformOs,
  arch: ExecutionEnvironmentPlatformArch,
  machine: z.string().optional(),
});
export type ExecutionEnvironmentPlatform = z.infer<typeof ExecutionEnvironmentPlatform>;

export const ExecutionEnvironmentCapabilities = z.looseObject({
  repositoryIdentity: z.boolean().default(false),
  connectionProbe: z.boolean().optional(),
  attachmentUploads: z.boolean().optional(),
  questionAttachments: z.boolean().optional(),
  fileAttachments: z.looseObject({ maxUploadBytes: z.number().int().min(1) }).optional(),
});
export type ExecutionEnvironmentCapabilities = z.infer<typeof ExecutionEnvironmentCapabilities>;

export const ExecutionEnvironmentDescriptor = z.looseObject({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  platform: ExecutionEnvironmentPlatform,
  serverVersion: TrimmedNonEmptyString,
  capabilities: ExecutionEnvironmentCapabilities,
});
export type ExecutionEnvironmentDescriptor = z.infer<typeof ExecutionEnvironmentDescriptor>;
