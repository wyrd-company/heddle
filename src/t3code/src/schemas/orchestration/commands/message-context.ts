// ---
// relationships:
//   implements:
//     - t3-code-client
//     - agent-tools
//     - node-types
// ---
import { z } from "zod";
import {
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  forwardCompatibleArray,
  forwardCompatibleLiteral,
} from "../../common.js";

export const ComposerContextId = TrimmedNonEmptyString.max(128)
  .regex(/^[a-z0-9_-]+$/i)
  .brand<"ComposerContextId">();
export type ComposerContextId = z.infer<typeof ComposerContextId>;
const ShortString = z.string().max(2048);
const NullableShortString = ShortString.nullable();
const recordBase = {
  version: z.literal(1),
  contextId: ComposerContextId,
  label: z.string().max(200),
};
const attachmentBinding = {
  attachmentId: TrimmedNonEmptyString.max(128).regex(/^[a-z0-9_-]+$/i),
  name: TrimmedNonEmptyString.max(255),
  mimeType: TrimmedNonEmptyString.max(100),
  sizeBytes: NonNegativeInt,
};

export const ImageContextRecord = z.looseObject({
  ...recordBase,
  kind: z.literal("image"),
  ...attachmentBinding,
});
export type ImageContextRecord = z.infer<typeof ImageContextRecord>;
export const FileContextRecord = z.looseObject({
  ...recordBase,
  kind: z.literal("file"),
  ...attachmentBinding,
});
export type FileContextRecord = z.infer<typeof FileContextRecord>;
export const TerminalContextRecord = z
  .looseObject({
    ...recordBase,
    kind: z.literal("terminal"),
    terminalId: TrimmedNonEmptyString.max(255),
    terminalLabel: TrimmedNonEmptyString.max(255),
    lineStart: NonNegativeInt,
    lineEnd: NonNegativeInt,
    text: z.string().max(64000),
  })
  .refine((record) => record.lineEnd >= record.lineStart);
export type TerminalContextRecord = z.infer<typeof TerminalContextRecord>;
export const ElementContextSource = z.looseObject({
  functionName: NullableShortString,
  fileName: NullableShortString,
  lineNumber: NonNegativeInt.nullable(),
  columnNumber: NonNegativeInt.nullable(),
});
export type ElementContextSource = z.infer<typeof ElementContextSource>;
export const ElementContextDetails = z.looseObject({
  pageUrl: ShortString,
  pageTitle: NullableShortString,
  tagName: TrimmedNonEmptyString.max(255),
  selector: NullableShortString,
  htmlPreview: z.string().max(8000),
  componentName: NullableShortString,
  source: ElementContextSource.nullable(),
  styles: z.string().max(8000),
});
export type ElementContextDetails = z.infer<typeof ElementContextDetails>;
export const ElementContextRecord = z.looseObject({
  ...recordBase,
  kind: z.literal("element"),
  ...ElementContextDetails.shape,
});
export type ElementContextRecord = z.infer<typeof ElementContextRecord>;
export const PreviewAnnotationContextRecord = z.looseObject({
  ...recordBase,
  kind: z.literal("preview-annotation"),
  annotationId: ShortString,
  pageUrl: ShortString,
  pageTitle: NullableShortString,
  comment: z.string().max(8000),
  targetSummary: ShortString,
  styleChanges: z.array(ShortString).max(200),
  elements: z.array(ElementContextDetails).max(50).optional(),
  elementIds: z.array(ShortString).max(50).optional(),
  regionCount: NonNegativeInt.optional(),
  strokeCount: NonNegativeInt.optional(),
  styleChangeDetails: z
    .array(
      z.looseObject({
        targetId: ShortString,
        selector: NullableShortString,
        property: ShortString,
        previousValue: z.string().max(8000),
        value: z.string().max(8000),
      }),
    )
    .max(200)
    .optional(),
  screenshotContextId: ComposerContextId.optional(),
});
export type PreviewAnnotationContextRecord = z.infer<typeof PreviewAnnotationContextRecord>;
export const PullRequestContextMetadata = z.looseObject({
  number: PositiveInt,
  title: ShortString,
  url: ShortString,
  headBranch: ShortString,
  baseBranch: ShortString,
  state: forwardCompatibleLiteral(["open", "closed", "merged"]),
  isDraft: z.boolean(),
});
export type PullRequestContextMetadata = z.infer<typeof PullRequestContextMetadata>;
export const ReviewCommentContextRecord = z
  .looseObject({
    ...recordBase,
    kind: z.literal("review-comment"),
    sectionId: TrimmedNonEmptyString.max(255),
    sectionTitle: ShortString,
    filePath: TrimmedNonEmptyString.max(2048),
    startIndex: NonNegativeInt,
    endIndex: NonNegativeInt,
    rangeLabel: ShortString,
    text: z.string().max(16000),
    diff: z.string().max(32000),
    fenceLanguage: z.string().max(64).optional(),
    pullRequest: PullRequestContextMetadata.optional(),
  })
  .refine((record) => record.endIndex >= record.startIndex);
export type ReviewCommentContextRecord = z.infer<typeof ReviewCommentContextRecord>;
export const MentionContextRecord = z.looseObject({
  ...recordBase,
  kind: z.literal("mention"),
  path: TrimmedNonEmptyString.max(2048),
});
export type MentionContextRecord = z.infer<typeof MentionContextRecord>;
export const SkillContextRecord = z.looseObject({
  ...recordBase,
  kind: z.literal("skill"),
  name: TrimmedNonEmptyString.max(255),
});
export type SkillContextRecord = z.infer<typeof SkillContextRecord>;

const knownKinds = [
  "image",
  "file",
  "terminal",
  "element",
  "preview-annotation",
  "review-comment",
  "mention",
  "skill",
];
function fitsJson(value: unknown, maximum: number): boolean {
  try {
    const encoded = JSON.stringify(value);
    return encoded !== undefined && encoded.length <= maximum;
  } catch {
    return false;
  }
}
// This contract preserves contextId even for unknown kinds so references still resolve.
export const UnknownContextRecord = z.looseObject({
  ...recordBase,
  kind: forwardCompatibleLiteral(["unknown"]).refine(
    (kind) => /^[a-z][a-z0-9-]{0,39}$/.test(kind) && !knownKinds.includes(kind),
  ),
  payload: z.unknown().refine((value) => fitsJson(value, 64000)),
});
export type UnknownContextRecord = z.infer<typeof UnknownContextRecord>;
export const ComposerContextRecord = z.union([
  ImageContextRecord,
  FileContextRecord,
  TerminalContextRecord,
  ElementContextRecord,
  PreviewAnnotationContextRecord,
  ReviewCommentContextRecord,
  MentionContextRecord,
  SkillContextRecord,
  UnknownContextRecord,
]);
export type ComposerContextRecord = z.infer<typeof ComposerContextRecord>;
export const OrchestrationMessageContext = z.looseObject({
  version: z.literal(1),
  records: z
    .array(z.unknown())
    .max(200)
    .refine((records) => fitsJson(records, 16000000))
    .transform((records): unknown => records)
    .pipe(forwardCompatibleArray(ComposerContextRecord))
    .refine(
      (records) => new Set(records.map((record) => record.contextId)).size === records.length,
    ),
});
export type OrchestrationMessageContext = z.infer<typeof OrchestrationMessageContext>;
