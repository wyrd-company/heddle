// ---
// relationships:
//   implements:
//     - t3-code-client
//     - agent-tools
//     - node-types
// ---
import { z } from "zod";
import { CommandId, IsoDateTime, ProjectId, TrimmedNonEmptyString } from "../../common.js";
import {
  ModelSelection,
  ProjectFaviconPath,
  ProjectIconOverride,
  ProjectScript,
} from "../model.js";

export const ProjectCreateCommand = z.looseObject({
  type: z.literal("project.create"),
  commandId: CommandId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  createWorkspaceRootIfMissing: z.boolean().optional(),
  defaultModelSelection: ModelSelection.nullable().optional(),
  createdAt: IsoDateTime,
});
export type ProjectCreateCommand = z.infer<typeof ProjectCreateCommand>;
export const ProjectDeleteCommand = z.looseObject({
  type: z.literal("project.delete"),
  commandId: CommandId,
  projectId: ProjectId,
  force: z.boolean().optional(),
});
export type ProjectDeleteCommand = z.infer<typeof ProjectDeleteCommand>;
export const ProjectMetaUpdateCommand = z.looseObject({
  type: z.literal("project.meta.update"),
  commandId: CommandId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString.optional(),
  workspaceRoot: TrimmedNonEmptyString.optional(),
  defaultModelSelection: ModelSelection.nullable().optional(),
  defaultThreadEnvMode: z.enum(["local", "worktree"]).nullable().optional(),
  autoPull: z.boolean().optional(),
  faviconPath: ProjectFaviconPath.nullable().optional(),
  projectIcon: ProjectIconOverride.nullable().optional(),
  scripts: z.array(ProjectScript).optional(),
});
export type ProjectMetaUpdateCommand = z.infer<typeof ProjectMetaUpdateCommand>;
