import { projectId, threadId, turnId, type MessageId } from "../../src/schemas/common.js";
import type { OrchestrationSession } from "../../src/schemas/orchestration/read-model.js";
import { OrchestrationEvent } from "../../src/schemas/orchestration/events.js";
import {
  OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadDetailSnapshot,
} from "../../src/schemas/orchestration/read-model.js";
import {
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  OrchestrationThreadShell,
} from "../../src/schemas/orchestration/shell.js";

export const ids = {
  threadId: threadId("thread-1"),
  projectId: projectId("project-1"),
  turnId: turnId("turn-1"),
};

export const at = "2020-01-01T00:00:00.000Z";

const threadBase = {
  id: ids.threadId,
  projectId: ids.projectId,
  title: "Sample thread",
  modelSelection: { instanceId: "sample-provider", model: "sample-model" },
  runtimeMode: "auto",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: at,
  updatedAt: at,
  deletedAt: null,
  session: null,
};

export function makeThread(overrides: Record<string, unknown> = {}): OrchestrationThread {
  return OrchestrationThread.parse({
    ...threadBase,
    messages: [],
    activities: [],
    checkpoints: [],
    ...overrides,
  });
}

export function makeShellThread(overrides: Record<string, unknown> = {}): OrchestrationThreadShell {
  return OrchestrationThreadShell.parse({
    ...threadBase,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  });
}

export function makeShellProject(
  overrides: Record<string, unknown> = {},
): OrchestrationProjectShell {
  return OrchestrationProjectShell.parse({
    id: ids.projectId,
    title: "Sample project",
    workspaceRoot: "/srv/sample",
    defaultModelSelection: null,
    scripts: [],
    createdAt: at,
    updatedAt: at,
    ...overrides,
  });
}

export function makeShellSnapshot(input: {
  projects?: OrchestrationProjectShell[];
  threads?: OrchestrationThreadShell[];
  snapshotSequence?: number;
}): OrchestrationShellSnapshot {
  return OrchestrationShellSnapshot.parse({
    snapshotSequence: input.snapshotSequence ?? 1,
    projects: input.projects ?? [],
    threads: input.threads ?? [],
    updatedAt: at,
  });
}

export function makeSnapshot(
  thread: OrchestrationThread,
  snapshotSequence: number,
): OrchestrationThreadDetailSnapshot {
  return { snapshotSequence, thread };
}

export function makeSession(overrides: Partial<OrchestrationSession> = {}): OrchestrationSession {
  return {
    threadId: ids.threadId,
    status: "idle",
    providerName: null,
    runtimeMode: "auto",
    activeTurnId: null,
    lastError: null,
    updatedAt: at,
    ...overrides,
  };
}

export function rawEvent(
  sequence: number,
  type: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    sequence,
    eventId: `event-${sequence}`,
    aggregateKind: "thread",
    aggregateId: ids.threadId,
    occurredAt: at,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload: { threadId: ids.threadId, ...payload },
  };
}

export function parseEvent(raw: Record<string, unknown>): OrchestrationEvent {
  return OrchestrationEvent.parse(raw);
}

export const events = {
  sessionSet: (sequence: number, session: Partial<OrchestrationSession>) =>
    rawEvent(sequence, "thread.session-set", { session: makeSession(session) }),
  messageSent: (
    sequence: number,
    message: {
      messageId: string;
      role?: "user" | "assistant";
      text: string;
      streaming?: boolean;
      turnId?: string | null;
    },
  ) =>
    rawEvent(sequence, "thread.message-sent", {
      messageId: message.messageId,
      role: message.role ?? "assistant",
      text: message.text,
      turnId: message.turnId === undefined ? ids.turnId : message.turnId,
      streaming: message.streaming ?? true,
      createdAt: at,
      updatedAt: at,
    }),
  turnStartRequested: (sequence: number, messageId: MessageId | string) =>
    rawEvent(sequence, "thread.turn-start-requested", {
      messageId,
      runtimeMode: "auto",
      interactionMode: "default",
      createdAt: at,
    }),
  activityAppended: (
    sequence: number,
    activity: Partial<Omit<OrchestrationThreadActivity, "id">> & { id?: string },
  ) =>
    rawEvent(sequence, "thread.activity-appended", {
      activity: {
        id: `activity-${sequence}`,
        tone: "approval",
        kind: "approval.requested",
        summary: "Sample activity",
        payload: {},
        turnId: ids.turnId,
        createdAt: at,
        ...activity,
      },
    }),
  turnDiffCompleted: (
    sequence: number,
    input: { turnId?: string; status?: "ready" | "missing" | "error"; assistantMessageId?: string },
  ) =>
    rawEvent(sequence, "thread.turn-diff-completed", {
      turnId: input.turnId ?? ids.turnId,
      checkpointTurnCount: 1,
      checkpointRef: "checkpoint-1",
      status: input.status ?? "ready",
      files: [],
      assistantMessageId: input.assistantMessageId ?? null,
      completedAt: at,
    }),
  metaUpdated: (sequence: number, patch: Record<string, unknown>) =>
    rawEvent(sequence, "thread.meta-updated", { updatedAt: at, ...patch }),
  archived: (sequence: number) =>
    rawEvent(sequence, "thread.archived", { archivedAt: at, updatedAt: at }),
  reverted: (sequence: number, turnCount: number) =>
    rawEvent(sequence, "thread.reverted", { turnCount }),
  snoozed: (sequence: number, snoozedUntil: string) =>
    rawEvent(sequence, "thread.snoozed", { snoozedUntil, snoozedAt: at, updatedAt: at }),
  unsnoozed: (sequence: number) =>
    rawEvent(sequence, "thread.unsnoozed", { reason: "user", updatedAt: at }),
  pinned: (sequence: number, pinOrderKey?: string) =>
    rawEvent(sequence, "thread.pinned", {
      pinnedAt: at,
      ...(pinOrderKey === undefined ? {} : { pinOrderKey }),
      updatedAt: at,
    }),
  unpinned: (sequence: number) => rawEvent(sequence, "thread.unpinned", { updatedAt: at }),
  pullRequestLinked: (sequence: number, number: number) =>
    rawEvent(sequence, "thread.pull-request-linked", {
      link: {
        host: "Example.test",
        repository: "Sample/Repo",
        number,
        url: `https://example.test/sample/repo/pull/${number}`,
        source: "manual",
        linkedAt: at,
        snapshot: null,
        stack: null,
      },
      updatedAt: at,
    }),
  pullRequestUnlinked: (sequence: number, number: number) =>
    rawEvent(sequence, "thread.pull-request-unlinked", {
      host: "example.test",
      repository: "sample/repo",
      number,
      updatedAt: at,
    }),
  pullRequestSynced: (sequence: number, number: number, state: "open" | "merged") =>
    rawEvent(sequence, "thread.pull-request-synced", {
      host: "example.test",
      repository: "sample/repo",
      number,
      snapshot: {
        state,
        title: "Sample change",
        headBranch: "feature",
        baseBranch: "main",
        isDraft: false,
        updatedAt: at,
        syncedAt: at,
      },
      stack: null,
      updatedAt: at,
    }),
};

export function makeMessage(input: {
  id: string;
  role?: "user" | "assistant" | "system";
  text?: string;
  turnId?: string | null;
  createdAt?: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    role: input.role ?? "assistant",
    text: input.text ?? input.id,
    turnId: input.turnId === undefined ? ids.turnId : input.turnId,
    streaming: false,
    createdAt: input.createdAt ?? at,
    updatedAt: input.createdAt ?? at,
  };
}

export function makeCheckpoint(input: {
  turnId: string;
  checkpointTurnCount: number;
  status?: "ready" | "missing" | "error";
  assistantMessageId?: string | null;
  completedAt?: string;
}): Record<string, unknown> {
  return {
    turnId: input.turnId,
    checkpointTurnCount: input.checkpointTurnCount,
    checkpointRef: `checkpoint-${input.checkpointTurnCount}`,
    status: input.status ?? "ready",
    files: [],
    assistantMessageId: input.assistantMessageId ?? null,
    completedAt: input.completedAt ?? at,
  };
}

export const approvalRequested = (requestId: string) =>
  ({
    kind: "approval.requested",
    payload: { requestId, requestKind: "command", detail: "run sample" },
  }) as const;

export const approvalResolved = (requestId: string) =>
  ({ kind: "approval.resolved", payload: { requestId, decision: "accept" } }) as const;

export const userInputRequested = (requestId: string) =>
  ({
    kind: "user-input.requested",
    tone: "info",
    payload: {
      requestId,
      questions: [{ id: "q1", question: "Proceed?", options: [{ label: "yes" }] }],
    },
  }) as const;
