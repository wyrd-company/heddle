// ---
// relationships:
//   implements: heddle
// ---

import {
  createConsoleAttention,
  type ConsoleAttention,
  type ConsoleAttentionAction,
} from "../console/index.js";
import type {
  DurableAttentionRecord,
  IncidentRuntimeRecord,
  NotificationFailureRecord,
  ReconcilerRuntimeRecord,
} from "../persistence/index.js";
import {
  escalationQuestions,
  requiredAttentionIdentifier as requiredIdentifier,
  requiredAttentionString as requiredString,
  t3Questions,
  type AttentionPayload as Payload,
} from "./attention-question-projection.js";
import {
  productionErrorIncidentEligible,
  productionErrorIncidentId,
  schedulerPassFailureCode,
  type ProductionErrorCode,
} from "./error-visibility.js";

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

const validTaskId = (value: unknown, attentionId: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Attention '${attentionId}' has no valid taskId`);
  }
  return value as number;
};

const taskForInstance = (
  instanceId: string,
  runtimes: Array<Pick<ReconcilerRuntimeRecord, "instanceId" | "taskId">>,
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
  return validTaskId(matches[0]!.taskId, attentionId);
};

const latestIncidentForAttention = (
  incidents: readonly IncidentRuntimeRecord[],
  attentionId: string,
): IncidentRuntimeRecord | undefined =>
  incidents.reduce<IncidentRuntimeRecord | undefined>(
    (latest, runtime) =>
      runtime.attentionId === attentionId &&
      (latest === undefined || runtime.occurrence > latest.occurrence)
        ? runtime
        : latest,
    undefined,
  );

const projectEscalation = (
  payload: Payload,
  instanceId: string,
  taskId: number,
  attentionId: string,
): ConsoleAttention => {
  const questions = escalationQuestions(payload["questions"], attentionId);
  requiredString(payload, "openedAt", attentionId);
  requiredIdentifier(payload, "stage", attentionId);
  const action: ConsoleAttentionAction = {
    actionId: "escalation.answer",
    contract: {
      escalationId: requiredIdentifier(payload, "escalationId", attentionId),
      instanceId,
      kind: "escalation.answer",
      ownerSessionKey: requiredIdentifier(
        payload,
        "ownerSessionKey",
        attentionId,
      ),
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
  incidentId?: string,
): ConsoleAttention => {
  const sessionKey = requiredIdentifier(payload, "sessionKey", attentionId);
  const threadId = requiredIdentifier(payload, "threadId", attentionId);
  const requestId =
    kind === "approval" || kind === "user-input"
      ? requiredIdentifier(payload, "requestId", attentionId)
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
        : ["ended", "failed", "stalled"].includes(kind)
          ? [
              {
                actionId: "attention.resolve",
                contract: { kind: "attention.resolve" as const },
                input: { kind: "none" as const },
                label: "Resolve",
              },
            ]
          : [];
  return createConsoleAttention({
    actions,
    attentionId,
    ...(incidentId === undefined ? {} : { incidentId }),
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
  notificationFailure?: NotificationFailureRecord,
  schedulerFailureSequence?: number,
  incidents: IncidentRuntimeRecord[] = [],
): ConsoleAttention => {
  const instanceRuntimes = [
    ...runtimes,
    ...incidents.map((runtime) => ({
      instanceId: runtime.incidentId,
      taskId: runtime.taskId,
    })),
  ];
  const payload = recordPayload(record);
  const attentionId = record.attentionId;
  const kind = payload["kind"];
  if (kind === "blueprint-repository") {
    requiredIdentifier(payload, "code", attentionId);
    requiredString(payload, "repositoryRoot", attentionId);
    return createConsoleAttention({
      actions: [],
      attentionId,
      kind,
      message: requiredString(payload, "message", attentionId),
      scope: "all",
    });
  }
  if (kind === undefined) {
    const instanceId = requiredIdentifier(payload, "instanceId", attentionId);
    return projectEscalation(
      payload,
      instanceId,
      taskForInstance(instanceId, instanceRuntimes, attentionId),
      attentionId,
    );
  }
  if (kind === "incident-production-mutation-approval") {
    const instanceId = requiredIdentifier(payload, "incidentId", attentionId);
    const taskId = validTaskId(payload["taskId"], attentionId);
    if (taskForInstance(instanceId, instanceRuntimes, attentionId) !== taskId) {
      throw new Error(
        `Attention '${attentionId}' disagrees with its production task`,
      );
    }
    const proposalDigest = requiredIdentifier(
      payload,
      "proposalDigest",
      attentionId,
    );
    return createConsoleAttention({
      actions: [
        {
          actionId: "incident.production-mutation.approve",
          contract: {
            instanceId,
            kind: "incident.production-mutation.approve",
            proposalDigest,
          },
          input: { kind: "none" },
          label: "Approve production mutation",
        },
      ],
      attentionId,
      instanceId,
      kind,
      message: requiredString(payload, "message", attentionId),
      scope: `task:${taskId}`,
      taskId,
    });
  }
  if (
    kind === "approval" ||
    kind === "user-input" ||
    kind === "ended" ||
    kind === "failed" ||
    kind === "stalled"
  ) {
    const instanceId = requiredIdentifier(payload, "instanceId", attentionId);
    return projectSessionAttention(
      payload,
      instanceId,
      taskForInstance(instanceId, instanceRuntimes, attentionId),
      attentionId,
      kind,
      latestIncidentForAttention(incidents, attentionId)?.incidentId,
    );
  }
  if (
    kind === "epic-acceptance" ||
    kind === "lifecycle-resolution" ||
    kind === "stale-instance"
  ) {
    const taskId = validTaskId(payload["taskId"], attentionId);
    requiredIdentifier(payload, "code", attentionId);
    const instanceId = payload["instanceId"];
    if (instanceId !== undefined && typeof instanceId !== "string") {
      throw new Error(`Attention '${attentionId}' has no valid instanceId`);
    }
    if (
      typeof instanceId === "string" &&
      taskForInstance(instanceId, instanceRuntimes, attentionId) !== taskId
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
      scope: `${kind === "epic-acceptance" ? "epic" : "task"}:${taskId}`,
      taskId,
    });
  }
  if (kind === "production-error") {
    const code = requiredIdentifier(payload, "code", attentionId);
    const productionErrorCode = code as ProductionErrorCode;
    const incidentIdValue = payload["incidentId"];
    const expectedIncidentId = productionErrorIncidentEligible(
      productionErrorCode,
    )
      ? productionErrorIncidentId(attentionId)
      : null;
    const latestIncident = latestIncidentForAttention(incidents, attentionId);
    if (
      incidentIdValue !== undefined &&
      incidentIdValue !== expectedIncidentId
    ) {
      throw new Error(
        `Attention '${attentionId}' has an invalid incident identity`,
      );
    }
    const taskIdValue = payload["taskId"];
    const instanceIdValue = payload["instanceId"];
    const taskId =
      taskIdValue === null ? undefined : validTaskId(taskIdValue, attentionId);
    if (
      instanceIdValue !== null &&
      instanceIdValue !== undefined &&
      (typeof instanceIdValue !== "string" || instanceIdValue.trim() === "")
    ) {
      throw new Error(`Attention '${attentionId}' has no valid instanceId`);
    }
    if (
      typeof instanceIdValue === "string" &&
      (taskId === undefined ||
        taskForInstance(instanceIdValue, instanceRuntimes, attentionId) !==
          taskId)
    ) {
      throw new Error(
        `Attention '${attentionId}' disagrees with its production task`,
      );
    }
    const notificationOccurrence =
      code === "notification-delivery-rejected" ||
      code === "notification-delivery-recovery-required"
        ? validTaskId(payload["notificationOccurrence"], attentionId)
        : undefined;
    const notificationStableId =
      notificationOccurrence === undefined
        ? undefined
        : requiredIdentifier(payload, "notificationStableId", attentionId);
    const verification =
      notificationOccurrence !== undefined &&
      notificationFailure !== undefined &&
      notificationFailure.stableId === notificationStableId &&
      notificationFailure.occurrence === notificationOccurrence &&
      notificationFailure.state === "rejected" &&
      notificationFailure.recipientLabel !== null &&
      notificationFailure.message !== null
        ? {
            message: notificationFailure.message,
            recipientLabel: notificationFailure.recipientLabel,
          }
        : undefined;
    const notificationActions: ConsoleAttentionAction[] =
      (code === "notification-delivery-rejected" ||
        code === "notification-delivery-recovery-required") &&
      verification !== undefined
        ? [
            {
              actionId: "notification.retry",
              contract: {
                kind: "notification.retry",
                occurrence: notificationOccurrence!,
              },
              input: { kind: "none" },
              label: "Retry notification",
            },
          ]
        : [];
    const actions: ConsoleAttentionAction[] = [
      ...notificationActions,
      {
        actionId: "attention.resolve",
        contract: {
          kind: "attention.resolve",
          ...(code === schedulerPassFailureCode &&
          schedulerFailureSequence !== undefined
            ? { schedulerFailureSequence }
            : {}),
        },
        input: { kind: "none" },
        label: "Resolve",
      },
    ];
    return createConsoleAttention({
      actions,
      attentionId,
      ...(typeof expectedIncidentId === "string"
        ? { incidentId: latestIncident?.incidentId ?? expectedIncidentId }
        : {}),
      ...(typeof instanceIdValue === "string"
        ? { instanceId: instanceIdValue }
        : {}),
      kind,
      message: `${requiredString(payload, "message", attentionId)}${notificationOccurrence !== undefined && verification === undefined ? " Retry is unavailable because the intended recipient and message cannot be verified." : ""}`,
      ...(verification === undefined
        ? {}
        : { notificationVerification: verification }),
      scope: taskId === undefined ? "all" : `task:${taskId}`,
      ...(taskId === undefined ? {} : { taskId }),
    });
  }
  throw new Error(`Attention '${attentionId}' has an unknown kind`);
};
