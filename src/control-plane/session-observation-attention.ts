// ---
// relationships:
//   implements: heddle
// ---

import { createHash } from "node:crypto";

import type { JsonValue } from "../persistence/index.js";
import {
  objectPayload,
  sessionObservationEventTypes,
} from "./session-observation-events.js";
import type {
  SessionObservationAttention,
  SessionObservationOptions,
  SessionObservationTarget,
} from "./session-observation-types.js";
import type {
  T3ThreadActivity,
  T3ThreadSnapshot,
  T3UserInputQuestion,
} from "./t3-control-plane-client.js";

export type RequestAttentionKind = "approval" | "user-input";

export const observationHash = (...parts: JsonValue[]): string =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

const activityPayload = (
  activity: T3ThreadActivity,
): Record<string, unknown> | undefined =>
  typeof activity.payload === "object" &&
  activity.payload !== null &&
  !Array.isArray(activity.payload)
    ? activity.payload
    : undefined;

const requestIdFrom = (activity: T3ThreadActivity): string | undefined => {
  const requestId = activityPayload(activity)?.["requestId"];
  return typeof requestId === "string" && requestId.trim() !== ""
    ? requestId
    : undefined;
};

const staleRequestFailure = (activity: T3ThreadActivity): boolean => {
  const detail = activityPayload(activity)?.["detail"];
  if (typeof detail !== "string") return false;
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("stale pending approval request") ||
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending permission request") ||
    normalized.includes("stale pending user-input request") ||
    normalized.includes("unknown pending user-input request") ||
    normalized.includes("unknown pending user input request") ||
    normalized.includes("unknown pending codex user input request")
  );
};

export const pendingRequestActivitiesFor = (
  snapshot: T3ThreadSnapshot,
  kind: "approval.requested" | "user-input.requested",
): T3ThreadActivity[] => {
  const resolvedKind =
    kind === "approval.requested" ? "approval.resolved" : "user-input.resolved";
  const failedKind =
    kind === "approval.requested"
      ? "provider.approval.respond.failed"
      : "provider.user-input.respond.failed";
  const pending = new Map<string, T3ThreadActivity>();
  for (const activity of snapshot.thread.activities ?? []) {
    const requestId = requestIdFrom(activity);
    if (requestId === undefined) continue;
    if (activity.kind === kind) {
      pending.set(requestId, activity);
    } else if (
      activity.kind === resolvedKind ||
      (activity.kind === failedKind && staleRequestFailure(activity))
    ) {
      pending.delete(requestId);
    }
  }
  return [...pending.values()];
};

export const requestIdsFor = (
  snapshot: T3ThreadSnapshot,
  kind: "approval.requested" | "user-input.requested",
): string[] =>
  pendingRequestActivitiesFor(snapshot, kind)
    .map(requestIdFrom)
    .filter((requestId): requestId is string => requestId !== undefined);

export const requestIdFor = (
  snapshot: T3ThreadSnapshot,
  kind: "approval.requested" | "user-input.requested",
): string | undefined => requestIdsFor(snapshot, kind).at(-1);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

const userInputQuestionsFrom = (
  activity: T3ThreadActivity | undefined,
): T3UserInputQuestion[] => {
  const questions =
    activity === undefined
      ? undefined
      : activityPayload(activity)?.["questions"];
  if (!Array.isArray(questions)) {
    throw new Error("T3 pending user-input has no canonical question catalog");
  }
  return questions.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("T3 pending user-input has a malformed question catalog");
    }
    const question = value as Record<string, unknown>;
    if (
      !nonEmptyString(question["id"]) ||
      !nonEmptyString(question["question"]) ||
      (question["multiSelect"] !== undefined &&
        typeof question["multiSelect"] !== "boolean") ||
      !Array.isArray(question["options"])
    ) {
      throw new Error("T3 pending user-input has a malformed question catalog");
    }
    const options = question["options"].map((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("T3 pending user-input has a malformed option catalog");
      }
      const option = value as Record<string, unknown>;
      if (!nonEmptyString(option["label"])) {
        throw new Error("T3 pending user-input has a malformed option catalog");
      }
      if (
        option["description"] !== undefined &&
        !nonEmptyString(option["description"])
      ) {
        throw new Error("T3 pending user-input has a malformed option catalog");
      }
      return {
        ...(option["description"] === undefined
          ? {}
          : { description: option["description"] }),
        label: option["label"],
      };
    });
    if (
      question["header"] !== undefined &&
      !nonEmptyString(question["header"])
    ) {
      throw new Error("T3 pending user-input has a malformed question catalog");
    }
    return {
      ...(question["header"] === undefined
        ? {}
        : { header: question["header"] }),
      id: question["id"],
      multiSelect: question["multiSelect"] ?? false,
      options,
      question: question["question"],
    };
  });
};

export const userInputQuestionsFor = (
  snapshot: T3ThreadSnapshot,
  requestId?: string,
): T3UserInputQuestion[] =>
  userInputQuestionsFrom(
    pendingRequestActivitiesFor(snapshot, "user-input.requested").findLast(
      (activity) =>
        requestId === undefined || activity.payload?.requestId === requestId,
    ),
  );

export const ensureObservationAttention = async (
  options: SessionObservationOptions,
  attention: SessionObservationAttention,
): Promise<SessionObservationAttention> => {
  const recorded = options.persistence
    .replayEvents(attention.instanceId)
    .some(
      (event) =>
        event.type === sessionObservationEventTypes.attentionRequired &&
        objectPayload(event)["attentionId"] === attention.attentionId,
    );
  if (!recorded) {
    options.persistence.appendEvent(
      attention.instanceId,
      sessionObservationEventTypes.attentionRequired,
      attention,
    );
  }
  if (!(await options.attention.has(attention.attentionId))) {
    await options.attention.raise(attention);
  }
  return attention;
};

const MAXIMUM_TOOL_TITLE_LENGTH = 160;

const hasAsciiControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });

const toolTitleFor = (activity: T3ThreadActivity): string | undefined => {
  const value = activityPayload(activity)?.["toolTitle"];
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > MAXIMUM_TOOL_TITLE_LENGTH ||
    hasAsciiControlCharacter(value)
  ) {
    return undefined;
  }
  return value;
};

export const requestAttentions = async (
  options: SessionObservationOptions,
  target: SessionObservationTarget,
  snapshot: T3ThreadSnapshot,
  kind: RequestAttentionKind,
): Promise<SessionObservationAttention[]> => {
  const activityKind =
    kind === "approval" ? "approval.requested" : "user-input.requested";
  const requests = pendingRequestActivitiesFor(snapshot, activityKind);
  if (requests.length === 0) {
    throw new Error(`T3 reports pending ${kind} without a request ID`);
  }
  return Promise.all(
    requests.map((activity) => {
      const requestId = requestIdFrom(activity)!;
      const toolTitle =
        kind === "approval" ? toolTitleFor(activity) : undefined;
      return ensureObservationAttention(options, {
        attentionId: observationHash(
          target.instanceId,
          target.sessionKey,
          kind,
          requestId,
        ),
        instanceId: target.instanceId,
        kind,
        message:
          toolTitle === undefined
            ? `Session ${target.sessionKey} has pending ${kind}`
            : `Session ${target.sessionKey} requests approval for ${toolTitle}`,
        ...(kind === "user-input"
          ? { questions: userInputQuestionsFrom(activity) }
          : {}),
        requestId,
        sessionKey: target.sessionKey,
        threadId: target.threadId,
      });
    }),
  );
};
