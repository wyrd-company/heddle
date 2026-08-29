// ---
// relationships:
//   implements: heddle
//   references: t3-headless
// ---

import type { JsonValue } from "../persistence/index.js";
import {
  ensureCorrelationToken,
  type InstanceStateStore,
} from "./correlation-token.js";
import {
  assembleStageHandoff,
  type StageHandoffInput,
} from "./handoff-assembler.js";
import type {
  T3DispatchCommand,
  T3ProviderDispatchContext,
} from "./t3-control-plane-client.js";
import {
  ensureWorktree,
  type PreparedWorktree,
  type WorktreeInput,
} from "./worktree-creator.js";

type StoredStageHandoff = {
  correlationToken: string;
  handoff: string;
  kind: "stage-handoff";
  sessionKey: string;
};

export interface SessionT3Client {
  dispatch(
    command: T3DispatchCommand,
    providerContext?: T3ProviderDispatchContext,
  ): Promise<{ sequence: number }>;
}

export type SessionBootstrapInput = {
  handoff: Omit<StageHandoffInput, "correlationToken" | "todoList">;
  instanceId: string;
  interactionMode: string;
  modelSelection: { instanceId: string; model: string };
  projectId: string;
  providerContext: T3ProviderDispatchContext;
  runtimeMode: string;
  sessionKey: string;
  title: string;
  worktree: WorktreeInput;
};

export type SessionBootstrapResult = {
  correlationToken: string;
  handoff: string;
  threadId: string;
  worktree: PreparedWorktree;
};

export type SessionBootstrapDependencies = {
  ensureWorktree?: (input: WorktreeInput) => Promise<PreparedWorktree>;
  mintCorrelationToken?: () => string;
  nextId?: () => string;
  now?: () => string;
  persistence: InstanceStateStore;
  t3: SessionT3Client;
};

export type SessionSteeringInput = {
  interactionMode: string;
  message: string;
  providerContext: T3ProviderDispatchContext;
  runtimeMode: string;
  threadId: string;
};

export type SessionSteeringDependencies = {
  nextId?: () => string;
  now?: () => string;
  t3: SessionT3Client;
};

const isStoredHandoff = (value: JsonValue): value is StoredStageHandoff =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  value["kind"] === "stage-handoff" &&
  typeof value["sessionKey"] === "string" &&
  typeof value["correlationToken"] === "string" &&
  typeof value["handoff"] === "string";

const ensureStoredHandoff = (
  store: InstanceStateStore,
  input: SessionBootstrapInput,
  correlationToken: string,
): string => {
  while (true) {
    const current = store.getInstance(input.instanceId);
    if (current === undefined) {
      throw new Error(`Instance does not exist: ${input.instanceId}`);
    }
    const existing = current.state.handoffs
      .filter(isStoredHandoff)
      .find(({ sessionKey }) => sessionKey === input.sessionKey);
    if (existing !== undefined) {
      if (existing.correlationToken !== correlationToken) {
        throw new Error(
          `Stored handoff and correlation token disagree for '${input.sessionKey}'`,
        );
      }
      return existing.handoff;
    }

    const handoff = assembleStageHandoff({
      ...input.handoff,
      correlationToken,
      todoList: current.state.todoState,
    });
    const stored: StoredStageHandoff = {
      correlationToken,
      handoff,
      kind: "stage-handoff",
      sessionKey: input.sessionKey,
    };
    const claimed = store.compareAndSwapInstance(
      input.instanceId,
      current.version,
      {
        ...current.state,
        handoffs: [...current.state.handoffs, stored],
      },
    );
    if (claimed !== undefined) return handoff;
  }
};

export const bootstrapStageSession = async (
  input: SessionBootstrapInput,
  dependencies: SessionBootstrapDependencies,
): Promise<SessionBootstrapResult> => {
  const prepareWorktree = dependencies.ensureWorktree ?? ensureWorktree;
  const nextId = dependencies.nextId ?? (() => globalThis.crypto.randomUUID());
  const now = dependencies.now ?? (() => new Date().toISOString());
  const worktree = await prepareWorktree(input.worktree);
  const { token: correlationToken } = ensureCorrelationToken(
    dependencies.persistence,
    input.instanceId,
    input.sessionKey,
    dependencies.mintCorrelationToken,
  );
  const handoff = ensureStoredHandoff(
    dependencies.persistence,
    input,
    correlationToken,
  );
  const threadId = nextId();

  await dependencies.t3.dispatch({
    type: "thread.create",
    commandId: nextId(),
    threadId,
    projectId: input.projectId,
    title: input.title,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    branch: worktree.branch,
    worktreePath: worktree.path,
    createdAt: now(),
  });
  await dependencies.t3.dispatch(
    {
      type: "thread.turn.start",
      commandId: nextId(),
      threadId,
      message: {
        messageId: nextId(),
        role: "user",
        text: handoff,
        attachments: [],
      },
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      createdAt: now(),
    },
    input.providerContext,
  );

  return { correlationToken, handoff, threadId, worktree };
};

export const steerStageSession = async (
  input: SessionSteeringInput,
  dependencies: SessionSteeringDependencies,
): Promise<{ sequence: number }> => {
  const nextId = dependencies.nextId ?? (() => globalThis.crypto.randomUUID());
  const now = dependencies.now ?? (() => new Date().toISOString());
  return dependencies.t3.dispatch(
    {
      type: "thread.turn.start",
      commandId: nextId(),
      threadId: input.threadId,
      message: {
        messageId: nextId(),
        role: "user",
        text: input.message,
        attachments: [],
      },
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      createdAt: now(),
    },
    input.providerContext,
  );
};
