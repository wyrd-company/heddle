// ---
// relationships:
//   implements:
//     - t3-code-client
//     - agent-tools
//     - node-types
// ---
import { z } from "zod";
import {
  ApprovalRequestId,
  TrimmedNonEmptyString,
  forwardCompatibleLiteral,
  taggedUnionWithUnknown,
} from "../common.js";
import {
  ProviderApprovalDecision,
  ProviderRequestKind,
  ProviderUserInputAnswers,
} from "./model.js";

export const UserInputQuestionOption = z.looseObject({
  label: TrimmedNonEmptyString,
  description: z.string().optional(),
  value: z.string().optional(),
});
export type UserInputQuestionOption = z.infer<typeof UserInputQuestionOption>;
export const UserInputQuestion = z.looseObject({
  id: TrimmedNonEmptyString,
  question: TrimmedNonEmptyString,
  header: TrimmedNonEmptyString.optional(),
  multiSelect: z.boolean().default(false),
  allowCustomAnswer: z.boolean().optional(),
  options: z.array(UserInputQuestionOption),
});
export type UserInputQuestion = z.infer<typeof UserInputQuestion>;
export const ProviderApprovalOption = z.looseObject({
  decision: ProviderApprovalDecision,
  label: TrimmedNonEmptyString,
  warning: TrimmedNonEmptyString.optional(),
});
export type ProviderApprovalOption = z.infer<typeof ProviderApprovalOption>;
export const ApprovalRequestedPayload = z.looseObject({
  requestId: ApprovalRequestId,
  requestKind: ProviderRequestKind.optional(),
  requestType: z.string().optional(),
  detail: z.string().optional(),
  appName: z.string().optional(),
  options: z.array(ProviderApprovalOption).optional(),
});
export type ApprovalRequestedPayload = z.infer<typeof ApprovalRequestedPayload>;
export const ApprovalResolvedPayload = z.looseObject({
  requestId: ApprovalRequestId,
  requestKind: ProviderRequestKind.optional(),
  requestType: z.string().optional(),
  decision: ProviderApprovalDecision.optional(),
});
export type ApprovalResolvedPayload = z.infer<typeof ApprovalResolvedPayload>;
// Runtime ingestion can publish questions without a correlated request id.
export const UserInputRequestedPayload = z.looseObject({
  requestId: ApprovalRequestId.optional(),
  questions: z.array(UserInputQuestion),
  responseMode: forwardCompatibleLiteral(["message"]).optional(),
});
export type UserInputRequestedPayload = z.infer<typeof UserInputRequestedPayload>;
export const UserInputResolvedPayload = z.looseObject({
  requestId: ApprovalRequestId.optional(),
  answers: ProviderUserInputAnswers.optional(),
  dismissed: z.boolean().optional(),
});
export type UserInputResolvedPayload = z.infer<typeof UserInputResolvedPayload>;
export const ProviderApprovalRespondFailedPayload = z.looseObject({
  requestId: ApprovalRequestId,
  detail: z.string(),
});
export type ProviderApprovalRespondFailedPayload = z.infer<
  typeof ProviderApprovalRespondFailedPayload
>;
export const ProviderUserInputRespondFailedPayload = ProviderApprovalRespondFailedPayload;
export type ProviderUserInputRespondFailedPayload = z.infer<
  typeof ProviderUserInputRespondFailedPayload
>;

export const RequestActivity = taggedUnionWithUnknown("kind", [
  z.looseObject({ kind: z.literal("approval.requested"), payload: ApprovalRequestedPayload }),
  z.looseObject({ kind: z.literal("approval.resolved"), payload: ApprovalResolvedPayload }),
  z.looseObject({ kind: z.literal("user-input.requested"), payload: UserInputRequestedPayload }),
  z.looseObject({ kind: z.literal("user-input.resolved"), payload: UserInputResolvedPayload }),
  z.looseObject({
    kind: z.literal("provider.approval.respond.failed"),
    payload: ProviderApprovalRespondFailedPayload,
  }),
  z.looseObject({
    kind: z.literal("provider.user-input.respond.failed"),
    payload: ProviderUserInputRespondFailedPayload,
  }),
]);
export type RequestActivity = z.infer<typeof RequestActivity>;

const stalePhrases = [
  "stale pending approval request",
  "unknown pending approval request",
  "unknown pending permission request",
  "stale pending user-input request",
  "unknown pending user-input request",
  "unknown pending user input request",
  "unknown pending codex user input request",
];

/** Mirror the decider: activity order matters; transient failures keep requests open. */
export function openRequests<T extends { readonly kind: string; readonly payload: unknown }>(
  activities: readonly T[],
): Map<string, T> {
  const requests = new Map<string, T>();
  for (const activity of activities) {
    const payload = activity.payload;
    if (!payload || typeof payload !== "object") continue;
    const record = payload as Record<string, unknown>;
    const requestId = record["requestId"];
    if (typeof requestId !== "string") continue;
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      requests.set(requestId, activity);
    } else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      requests.delete(requestId);
    } else if (
      activity.kind === "provider.approval.respond.failed" ||
      activity.kind === "provider.user-input.respond.failed"
    ) {
      const detail = record["detail"];
      if (
        typeof detail === "string" &&
        stalePhrases.some((phrase) => detail.toLowerCase().includes(phrase))
      )
        requests.delete(requestId);
    }
  }
  return requests;
}
