// ---
// relationships:
//   implements:
//     - t3-code-client
//     - agent-tools
//     - node-types
// ---
import { z } from "zod";
import { TrimmedString } from "./common.js";
import {
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  forwardCompatibleLiteral,
} from "./common.js";

export const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
export const ProjectEntryKind = forwardCompatibleLiteral(["file", "directory"]);
export type ProjectEntryKind = z.infer<typeof ProjectEntryKind>;
export const ProjectSearchEntriesInput = z.looseObject({
  cwd: TrimmedNonEmptyString,
  query: TrimmedString.max(256),
  limit: PositiveInt.max(PROJECT_SEARCH_ENTRIES_MAX_LIMIT),
  kind: ProjectEntryKind.optional(),
  imageOnly: z.boolean().optional(),
});
export type ProjectSearchEntriesInput = z.infer<typeof ProjectSearchEntriesInput>;
export const ProjectEntry = z.looseObject({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  ignored: z.boolean().optional(),
});
export type ProjectEntry = z.infer<typeof ProjectEntry>;
export const ProjectSearchEntriesResult = z.looseObject({
  entries: z.array(ProjectEntry),
  truncated: z.boolean(),
});
export type ProjectSearchEntriesResult = z.infer<typeof ProjectSearchEntriesResult>;
export const PROJECT_SEARCH_CONTENTS_MAX_LIMIT = 500;
export const ProjectSearchContentsInput = z.looseObject({
  cwd: TrimmedNonEmptyString,
  query: z.string().min(1).max(256),
  limit: PositiveInt.max(PROJECT_SEARCH_CONTENTS_MAX_LIMIT),
  caseSensitive: z.boolean(),
  wholeWord: z.boolean(),
  useRegex: z.boolean(),
});
export type ProjectSearchContentsInput = z.infer<typeof ProjectSearchContentsInput>;
export const ProjectContentMatchRange = z.looseObject({
  start: NonNegativeInt,
  end: NonNegativeInt,
});
export type ProjectContentMatchRange = z.infer<typeof ProjectContentMatchRange>;
export const ProjectContentMatch = z.looseObject({
  path: TrimmedNonEmptyString,
  lineNumber: PositiveInt,
  lineContent: z.string(),
  matchRanges: z.array(ProjectContentMatchRange),
});
export type ProjectContentMatch = z.infer<typeof ProjectContentMatch>;
export const ProjectSearchContentsResult = z.looseObject({
  matches: z.array(ProjectContentMatch),
  truncated: z.boolean(),
  regexFallbackError: z.string().optional(),
});
export type ProjectSearchContentsResult = z.infer<typeof ProjectSearchContentsResult>;
export const ProjectListEntriesInput = z.looseObject({
  cwd: TrimmedNonEmptyString,
  directoryPath: TrimmedString.optional(),
});
export type ProjectListEntriesInput = z.infer<typeof ProjectListEntriesInput>;
export const ProjectListEntriesResult = z.looseObject({
  entries: z.array(ProjectEntry),
  truncated: z.boolean(),
});
export type ProjectListEntriesResult = z.infer<typeof ProjectListEntriesResult>;
export const PROJECT_READ_FILE_PATH_MAX_LENGTH = 512;
export const ProjectReadFileInput = z.looseObject({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.max(PROJECT_READ_FILE_PATH_MAX_LENGTH),
});
export type ProjectReadFileInput = z.infer<typeof ProjectReadFileInput>;
export const ProjectReadFileResult = z.looseObject({
  relativePath: TrimmedNonEmptyString,
  contents: z.string(),
  byteLength: NonNegativeInt,
  truncated: z.boolean(),
});
export type ProjectReadFileResult = z.infer<typeof ProjectReadFileResult>;
export const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
export const ProjectWriteFileInput = z.looseObject({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.max(PROJECT_WRITE_FILE_PATH_MAX_LENGTH),
  contents: z.string(),
});
export type ProjectWriteFileInput = z.infer<typeof ProjectWriteFileInput>;
export const ProjectWriteFileResult = z.looseObject({ relativePath: TrimmedNonEmptyString });
export type ProjectWriteFileResult = z.infer<typeof ProjectWriteFileResult>;
