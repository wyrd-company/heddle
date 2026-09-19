// ---
// relationships:
//   implements:
//     - t3-code-client
//     - agent-tools
//     - node-types
// ---
import { z } from "zod";
import { TrimmedString } from "../common.js";
import {
  IsoDateTime,
  NonNegativeInt,
  ProviderInstanceId,
  TrimmedNonEmptyString,
  forwardCompatibleLiteral,
  taggedUnionWithUnknown,
} from "../common.js";
import { ProviderOptionSelections } from "../provider.js";

export const ModelSelection = z.preprocess(
  (raw) => {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const value = raw as Record<string, unknown>;
      return {
        ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== "provider")),
        instanceId: value["instanceId"] !== undefined ? value["instanceId"] : value["provider"],
      };
    }
    return raw;
  },
  z.looseObject({
    instanceId: ProviderInstanceId,
    model: TrimmedNonEmptyString,
    options: ProviderOptionSelections.optional(),
  }),
);
export type ModelSelection = z.infer<typeof ModelSelection>;
export const ProviderInteractionMode = forwardCompatibleLiteral(["default", "plan"]);
export type ProviderInteractionMode = z.infer<typeof ProviderInteractionMode>;
export const ProviderApprovalDecision = forwardCompatibleLiteral([
  "accept",
  "acceptForSession",
  "acceptAlways",
  "decline",
  "cancel",
]);
export type ProviderApprovalDecision = z.infer<typeof ProviderApprovalDecision>;
export const ProviderRequestKind = forwardCompatibleLiteral([
  "command",
  "file-read",
  "file-change",
  "mcp-elicitation",
]);
export type ProviderRequestKind = z.infer<typeof ProviderRequestKind>;
export const ProviderUserInputAnswers = z.record(z.string(), z.unknown());
export type ProviderUserInputAnswers = z.infer<typeof ProviderUserInputAnswers>;
export const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;
export const ChatAttachmentId = TrimmedNonEmptyString.max(CHAT_ATTACHMENT_ID_MAX_CHARS).regex(
  /^[a-z0-9_-]+$/i,
);
export type ChatAttachmentId = z.infer<typeof ChatAttachmentId>;
export const PROVIDER_SEND_TURN_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const PastedTextAttachmentSource = z.looseObject({ _tag: z.literal("pasted-text") });
export type PastedTextAttachmentSource = z.infer<typeof PastedTextAttachmentSource>;
export const ChatFileAttachment = z.looseObject({
  type: z.literal("file"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.max(255),
  mimeType: TrimmedNonEmptyString.max(100),
  sizeBytes: NonNegativeInt.min(1).max(PROVIDER_SEND_TURN_MAX_FILE_BYTES),
  source: PastedTextAttachmentSource.optional(),
});
export type ChatFileAttachment = z.infer<typeof ChatFileAttachment>;
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS = 32_000;
const SnapShotAccessibilityBounds = z.looseObject({
  x: NonNegativeInt,
  y: NonNegativeInt,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
const SnapShotAccessibilityState = z.looseObject({
  active: z.boolean().optional(),
  busy: z.boolean().optional(),
  checked: forwardCompatibleLiteral(["on", "off", "mixed"]).optional(),
  editable: z.boolean().optional(),
  enabled: z.boolean().optional(),
  expanded: z.boolean().optional(),
  focused: z.boolean().optional(),
  selected: z.boolean().optional(),
  visible: z.boolean().optional(),
});
export const SnapShotAccessibilityNode = z.looseObject({
  role: TrimmedNonEmptyString.max(100),
  name: TrimmedNonEmptyString.max(1000).optional(),
  value: TrimmedNonEmptyString.max(8000).optional(),
  description: TrimmedNonEmptyString.max(2000).optional(),
  bounds: SnapShotAccessibilityBounds.nullable(),
  state: SnapShotAccessibilityState.optional(),
  actions: z.array(TrimmedNonEmptyString.max(100)).max(32).optional(),
  get children(): z.ZodArray<typeof SnapShotAccessibilityNode> {
    return z.array(SnapShotAccessibilityNode).max(10000);
  },
});
export type SnapShotAccessibilityNode = z.infer<typeof SnapShotAccessibilityNode>;
export const SnapShotAccessibility = taggedUnionWithUnknown("format", [
  z.looseObject({
    format: z.literal("flat-text"),
    text: TrimmedNonEmptyString.max(32000),
    truncated: z.boolean(),
  }),
  z.looseObject({
    format: z.literal("element-tree"),
    coordinateSpace: z.literal("captured-image"),
    imageSize: z.looseObject({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
    truncated: z.boolean(),
    root: SnapShotAccessibilityNode,
  }),
]).refine((value) => {
  if ("unknown" in value && value.unknown === true) return true;
  if (!("format" in value) || value.format !== "element-tree" || !("root" in value)) return true;
  const parsed = SnapShotAccessibilityNode.safeParse(value.root);
  if (!parsed.success) return false;
  const stack = [parsed.data];
  let count = 0;
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    count += 1;
    if (count > 10000) return false;
    stack.push(...node.children);
  }
  return JSON.stringify(value).length <= 32000;
});
export type SnapShotAccessibility = z.infer<typeof SnapShotAccessibility>;
export const SnapShotSource = z.looseObject({
  kind: z.literal("snap-shot"),
  capturedAt: IsoDateTime,
  appName: TrimmedNonEmptyString.max(255),
  windowTitle: TrimmedString.max(1_000),
  accessibleText: TrimmedNonEmptyString.max(SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS).optional(),
  accessibility: SnapShotAccessibility.optional(),
  appIdentifier: TrimmedNonEmptyString.max(255).optional(),
  appIconDataUrl: TrimmedNonEmptyString.max(100_000)
    .regex(/^data:image\/png;base64,/i)
    .optional(),
});
export type SnapShotSource = z.infer<typeof SnapShotSource>;
export const ChatImageAttachment = z.looseObject({
  type: z.literal("image"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.max(255),
  mimeType: TrimmedNonEmptyString.max(100).regex(/^image\//i),
  sizeBytes: NonNegativeInt.max(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES),
  source: SnapShotSource.optional(),
});
export type ChatImageAttachment = z.infer<typeof ChatImageAttachment>;
export const ChatUnknownAttachment = z.looseObject({
  type: TrimmedNonEmptyString.max(50).regex(/^(?!(?:image|file)$)/),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.max(255),
  mimeType: TrimmedNonEmptyString.max(100),
  sizeBytes: NonNegativeInt,
});
export type ChatUnknownAttachment = z.infer<typeof ChatUnknownAttachment>;
export const ChatAttachment = z.union([
  ChatImageAttachment,
  ChatFileAttachment,
  ChatUnknownAttachment,
]);
export type ChatAttachment = z.infer<typeof ChatAttachment>;
export const PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS = 14_000_000;
export const UploadChatImageAttachment = z.looseObject({
  type: z.literal("image"),
  id: ChatAttachmentId.optional(),
  name: TrimmedNonEmptyString.max(255),
  mimeType: TrimmedNonEmptyString.max(100).regex(/^image\//i),
  sizeBytes: NonNegativeInt.max(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES),
  dataUrl: TrimmedNonEmptyString.max(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS),
  source: SnapShotSource.optional(),
});
export type UploadChatImageAttachment = z.infer<typeof UploadChatImageAttachment>;
export const UploadChatAttachment = UploadChatImageAttachment;
export type UploadChatAttachment = z.infer<typeof UploadChatAttachment>;
export const ProjectScriptIcon = forwardCompatibleLiteral([
  "play",
  "test",
  "lint",
  "configure",
  "build",
  "debug",
]);
export type ProjectScriptIcon = z.infer<typeof ProjectScriptIcon>;
export const ProjectScript = z.looseObject({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  icon: ProjectScriptIcon,
  runOnWorktreeCreate: z.boolean(),
  async: z.boolean().optional(),
  previewUrl: TrimmedNonEmptyString.optional(),
  autoOpenPreview: z.boolean().optional(),
});
export type ProjectScript = z.infer<typeof ProjectScript>;
export const ProjectEmoji = TrimmedNonEmptyString.max(32);
export type ProjectEmoji = z.infer<typeof ProjectEmoji>;
export const ProjectIconColor = forwardCompatibleLiteral([
  "gray",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
]);
export type ProjectIconColor = z.infer<typeof ProjectIconColor>;
export const ProjectLucideIconName = TrimmedNonEmptyString.max(64).regex(
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
);
export type ProjectLucideIconName = z.infer<typeof ProjectLucideIconName>;
const monogramSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const ProjectMonogramText = TrimmedNonEmptyString.max(32)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N}\p{M}\u200c\u200d]*$/u)
  .refine((text) => Array.from(monogramSegmenter.segment(text)).length <= 2);
export type ProjectMonogramText = z.infer<typeof ProjectMonogramText>;
export const ProjectIconOverride = taggedUnionWithUnknown("kind", [
  z.looseObject({
    kind: z.literal("lucide"),
    name: ProjectLucideIconName,
    color: ProjectIconColor,
    monogram: ProjectMonogramText.optional(),
  }),
  z.looseObject({ kind: z.literal("emoji"), emoji: ProjectEmoji }),
]);
export type ProjectIconOverride = z.infer<typeof ProjectIconOverride>;
export const ProjectFaviconPath = TrimmedNonEmptyString.max(1024).regex(
  /\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/i,
);
export type ProjectFaviconPath = z.infer<typeof ProjectFaviconPath>;

export { RuntimeMode } from "../provider.js";

export { ModelCapabilities, ProviderOptionSelections } from "../provider.js";
