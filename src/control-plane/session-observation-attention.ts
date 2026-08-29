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

const requestActivityFor = (
  snapshot: T3ThreadSnapshot,
  kind: "approval.requested" | "user-input.requested",
): T3ThreadActivity | undefined =>
  snapshot.thread.activities
    ?.filter((activity) => activity.kind === kind)
    .at(-1);

export const requestIdFor = (
  snapshot: T3ThreadSnapshot,
  kind: "approval.requested" | "user-input.requested",
): string | undefined => requestActivityFor(snapshot, kind)?.payload?.requestId;

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

export const userInputQuestionsFor = (
  snapshot: T3ThreadSnapshot,
): T3UserInputQuestion[] => {
  const questions = requestActivityFor(snapshot, "user-input.requested")
    ?.payload?.["questions"];
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error("T3 pending user-input has no canonical question catalog");
  }
  const questionIds = new Set<string>();
  return questions.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("T3 pending user-input has a malformed question catalog");
    }
    const question = value as Record<string, unknown>;
    if (
      !nonEmptyString(question["id"]) ||
      !nonEmptyString(question["prompt"]) ||
      typeof question["multiSelect"] !== "boolean" ||
      !Array.isArray(question["options"]) ||
      question["options"].length < 2
    ) {
      throw new Error("T3 pending user-input has a malformed question catalog");
    }
    if (questionIds.has(question["id"])) {
      throw new Error(
        `T3 pending user-input repeats question '${question["id"]}'`,
      );
    }
    questionIds.add(question["id"]);
    const labels = new Set<string>();
    const options = question["options"].map((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("T3 pending user-input has a malformed option catalog");
      }
      const option = value as Record<string, unknown>;
      if (!nonEmptyString(option["label"])) {
        throw new Error("T3 pending user-input has a malformed option catalog");
      }
      if (labels.has(option["label"])) {
        throw new Error(
          `T3 pending user-input repeats option label '${option["label"]}'`,
        );
      }
      labels.add(option["label"]);
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
      multiSelect: question["multiSelect"],
      options,
      prompt: question["prompt"],
    };
  });
};

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

export const requestAttention = async (
  options: SessionObservationOptions,
  target: SessionObservationTarget,
  snapshot: T3ThreadSnapshot,
  kind: RequestAttentionKind,
): Promise<SessionObservationAttention> => {
  const activityKind =
    kind === "approval" ? "approval.requested" : "user-input.requested";
  const requestId = requestIdFor(snapshot, activityKind);
  if (requestId === undefined) {
    throw new Error(`T3 reports pending ${kind} without a request ID`);
  }
  return ensureObservationAttention(options, {
    attentionId: observationHash(
      target.instanceId,
      target.sessionKey,
      kind,
      requestId,
    ),
    instanceId: target.instanceId,
    kind,
    message: `Session ${target.sessionKey} has pending ${kind}`,
    ...(kind === "user-input"
      ? { questions: userInputQuestionsFor(snapshot) }
      : {}),
    requestId,
    sessionKey: target.sessionKey,
    threadId: target.threadId,
  });
};
