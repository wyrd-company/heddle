// ---
// relationships:
//   implements: heddle
// ---

import {
  createConsoleAttention,
  type ConsoleAttention,
  type ConsoleAttentionAction,
  type ConsoleAttentionQuestion,
} from "../console/index.js";
import type {
  DurableAttentionRecord,
  ReconcilerRuntimeRecord,
} from "../persistence/index.js";

type Payload = Record<string, unknown>;

const recordPayload = (record: DurableAttentionRecord): Payload => {
  const payload = record.payload;
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new Error(`Attention '${record.attentionId}' is malformed`);
  }
  if (payload["attentionId"] !== record.attentionId) {
    throw new Error(
      `Attention '${record.attentionId}' disagrees with its durable payload identity`,
    );
  }
  return payload;
};

const requiredString = (
  payload: Payload,
  field: string,
  attentionId: string,
): string => {
  const value = payload[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Attention '${attentionId}' has no valid ${field}`);
  }
  return value;
};

const taskForInstance = (
  instanceId: string,
  runtimes: ReconcilerRuntimeRecord[],
  attentionId: string,
): number => {
  const matches = runtimes.filter(
    (runtime) => runtime.instanceId === instanceId,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Attention '${attentionId}' does not resolve to one production task`,
    );
  }
  return matches[0]!.taskId;
};

const escalationQuestions = (
  value: unknown,
  attentionId: string,
): ConsoleAttentionQuestion[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Attention '${attentionId}' has no escalation questions`);
  }
  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`Attention '${attentionId}' has malformed questions`);
    }
    const question = item as Payload;
    const id = requiredString(question, "id", attentionId);
    const prompt = requiredString(question, "prompt", attentionId);
    if (!Array.isArray(question["options"]) || question["options"].length < 2) {
      throw new Error(`Attention '${attentionId}' has malformed options`);
    }
    return {
      id,
      multiSelect: false,
      options: question["options"].map((item) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
          throw new Error(`Attention '${attentionId}' has malformed options`);
        }
        const option = item as Payload;
        return {
          description: requiredString(option, "description", attentionId),
          label: requiredString(option, "label", attentionId),
          value: requiredString(option, "id", attentionId),
        };
      }),
      prompt,
    };
  });
};

const t3Questions = (
  value: unknown,
  attentionId: string,
): ConsoleAttentionQuestion[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Attention '${attentionId}' has no user-input questions`);
  }
  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`Attention '${attentionId}' has malformed questions`);
    }
    const question = item as Payload;
    if (typeof question["multiSelect"] !== "boolean") {
      throw new Error(`Attention '${attentionId}' has malformed questions`);
    }
    if (!Array.isArray(question["options"]) || question["options"].length < 2) {
      throw new Error(`Attention '${attentionId}' has malformed options`);
    }
    const header = question["header"];
    if (
      header !== undefined &&
      (typeof header !== "string" || header.trim() === "")
    ) {
      throw new Error(`Attention '${attentionId}' has malformed questions`);
    }
    return {
      ...(header === undefined ? {} : { header }),
      id: requiredString(question, "id", attentionId),
      multiSelect: question["multiSelect"],
      options: question["options"].map((item) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
          throw new Error(`Attention '${attentionId}' has malformed options`);
        }
        const option = item as Payload;
        const label = requiredString(option, "label", attentionId);
        const description = option["description"];
        if (
          description !== undefined &&
          (typeof description !== "string" || description.trim() === "")
        ) {
          throw new Error(`Attention '${attentionId}' has malformed options`);
        }
        return {
          ...(description === undefined ? {} : { description }),
          label,
          value: label,
        };
      }),
      prompt: requiredString(question, "question", attentionId),
    };
  });
};

const projectEscalation = (
  payload: Payload,
  instanceId: string,
  taskId: number,
  attentionId: string,
): ConsoleAttention => {
  const questions = escalationQuestions(payload["questions"], attentionId);
  const action: ConsoleAttentionAction = {
    actionId: "escalation.answer",
    contract: {
      escalationId: requiredString(payload, "escalationId", attentionId),
      instanceId,
      kind: "escalation.answer",
      ownerSessionKey: requiredString(payload, "ownerSessionKey", attentionId),
    },
    input: { kind: "questions", questions },
    label: "Answer escalation",
  };
  return createConsoleAttention({
    actions: [action],
    attentionId,
    instanceId,
    kind: "escalation",
    message: questions[0]!.prompt,
    scope: `task:${taskId}`,
    taskId,
  });
};

const projectSessionAttention = (
  payload: Payload,
  instanceId: string,
  taskId: number,
  attentionId: string,
  kind: string,
): ConsoleAttention => {
  const sessionKey = requiredString(payload, "sessionKey", attentionId);
  const threadId = requiredString(payload, "threadId", attentionId);
  const requestId =
    kind === "approval" || kind === "user-input"
      ? requiredString(payload, "requestId", attentionId)
      : undefined;
  const actions: ConsoleAttentionAction[] =
    kind === "approval"
      ? (["accept", "reject"] as const).map((decision) => ({
          actionId: `t3.approval.${decision}`,
          contract: {
            decision,
            instanceId,
            kind: "t3.approval.respond" as const,
            requestId: requestId!,
            sessionKey,
            threadId,
          },
          input: { kind: "none" as const },
          label: decision === "accept" ? "Accept" : "Reject",
        }))
      : kind === "user-input"
        ? [
            {
              actionId: "t3.user-input.respond",
              contract: {
                instanceId,
                kind: "t3.user-input.respond" as const,
                requestId: requestId!,
                sessionKey,
                threadId,
              },
              input: {
                kind: "questions" as const,
                questions: t3Questions(payload["questions"], attentionId),
              },
              label: "Answer questions",
            },
          ]
        : [];
  return createConsoleAttention({
    actions,
    attentionId,
    instanceId,
    kind,
    message: requiredString(payload, "message", attentionId),
    scope: `task:${taskId}`,
    taskId,
  });
};

export const projectProductionAttention = (
  record: DurableAttentionRecord,
  runtimes: ReconcilerRuntimeRecord[],
): ConsoleAttention => {
  const payload = recordPayload(record);
  const attentionId = record.attentionId;
  const kind = payload["kind"];
  if (kind === undefined) {
    const instanceId = requiredString(payload, "instanceId", attentionId);
    return projectEscalation(
      payload,
      instanceId,
      taskForInstance(instanceId, runtimes, attentionId),
      attentionId,
    );
  }
  if (
    kind === "approval" ||
    kind === "user-input" ||
    kind === "ended" ||
    kind === "failed" ||
    kind === "stalled"
  ) {
    const instanceId = requiredString(payload, "instanceId", attentionId);
    return projectSessionAttention(
      payload,
      instanceId,
      taskForInstance(instanceId, runtimes, attentionId),
      attentionId,
      kind,
    );
  }
  if (kind === "lifecycle-resolution" || kind === "stale-instance") {
    const taskId = payload["taskId"];
    if (!Number.isSafeInteger(taskId) || (taskId as number) <= 0) {
      throw new Error(`Attention '${attentionId}' has no valid taskId`);
    }
    const instanceId = payload["instanceId"];
    if (instanceId !== undefined && typeof instanceId !== "string") {
      throw new Error(`Attention '${attentionId}' has no valid instanceId`);
    }
    if (
      typeof instanceId === "string" &&
      taskForInstance(instanceId, runtimes, attentionId) !== taskId
    ) {
      throw new Error(
        `Attention '${attentionId}' disagrees with its production task`,
      );
    }
    return createConsoleAttention({
      actions: [],
      attentionId,
      ...(typeof instanceId === "string" ? { instanceId } : {}),
      kind,
      message: requiredString(payload, "message", attentionId),
      scope: `task:${taskId as number}`,
      taskId: taskId as number,
    });
  }
  throw new Error(`Attention '${attentionId}' has an unknown kind`);
};
