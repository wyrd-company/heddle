// ---
// relationships:
//   implements: heddle
// ---

import {
  assertResolvedSessionBinding,
  sameResolvedSessionBinding,
  type InstanceRecord,
  type InstanceState,
} from "../persistence/index.js";
import { isTodoState, todoSubtreeIds } from "../todo/index.js";
import type { TodoAssignment, TodoList } from "../todo/types.js";

export interface DelegationStateStore {
  /**
   * Replaces instance state atomically and rejects correlation-token values
   * already owned by any other instance/session in the durable store.
   */
  compareAndSwapInstance(
    instanceId: string,
    expectedVersion: number,
    state: InstanceState,
  ): InstanceRecord | undefined;
  getInstance(instanceId: string): InstanceRecord | undefined;
}

export type ClaimTodoAssignmentInput = {
  binding: TodoAssignment["binding"];
  bootstrap: TodoAssignment["bootstrap"];
  correlationToken: string;
  depth: number;
  instanceId: string;
  listSessionKey: string;
  model: string;
  operationId: string;
  parentSessionKey: string;
  parentThreadId: string;
  provider: string;
  rootItemId: string;
  sessionKey: string;
  stage: string;
  threadId: string;
};

const requireRecord = (
  store: Pick<DelegationStateStore, "getInstance">,
  instanceId: string,
): InstanceRecord => {
  const record = store.getInstance(instanceId);
  if (record === undefined)
    throw new Error(`Instance does not exist: ${instanceId}`);
  return record;
};

const requireList = (
  record: InstanceRecord,
  listSessionKey: string,
  stage: string,
): TodoList => {
  if (!isTodoState(record.state.todoState)) {
    throw new Error("The workflow instance has no valid todo state");
  }
  const list = record.state.todoState.lists.find(
    (candidate) => candidate.sessionKey === listSessionKey,
  );
  if (list === undefined || list.stage !== stage) {
    throw new Error("The stage session has no bound todo list");
  }
  return list;
};

const assignmentsOverlap = (
  list: TodoList,
  leftRoot: string,
  rightRoot: string,
): boolean => {
  const left = todoSubtreeIds(list, leftRoot);
  const right = todoSubtreeIds(list, rightRoot);
  return [...left].some((id) => right.has(id));
};

const assignmentAncestors = (
  assignments: readonly TodoAssignment[],
  parentSessionKey: string,
): ReadonlySet<string> => {
  const ancestors = new Set<string>();
  let sessionKey = parentSessionKey;
  while (true) {
    const owner = assignments.find(
      (assignment) =>
        assignment.status === "active" && assignment.sessionKey === sessionKey,
    );
    if (owner === undefined) return ancestors;
    if (ancestors.has(owner.sessionKey)) {
      throw new Error("Todo assignment parentage is cyclic");
    }
    ancestors.add(owner.sessionKey);
    sessionKey = owner.parentSessionKey;
  }
};

export const claimTodoAssignment = (
  store: DelegationStateStore,
  input: ClaimTodoAssignmentInput,
): TodoAssignment => {
  assertResolvedSessionBinding(input.binding, input.sessionKey, input.threadId);
  if (
    input.binding.providerInstanceId !== input.provider ||
    input.binding.modelSlug !== input.model
  ) {
    throw new Error(
      "Todo assignment provider and model must match its resolved session binding",
    );
  }
  const candidate: TodoAssignment = {
    binding: input.binding,
    bootstrap: input.bootstrap,
    correlationToken: input.correlationToken,
    depth: input.depth,
    model: input.model,
    operationId: input.operationId,
    parentSessionKey: input.parentSessionKey,
    parentThreadId: input.parentThreadId,
    provider: input.provider,
    rootItemId: input.rootItemId,
    sessionKey: input.sessionKey,
    status: "active",
    threadId: input.threadId,
  };
  while (true) {
    const current = requireRecord(store, input.instanceId);
    const list = requireList(current, input.listSessionKey, input.stage);
    const existing = (list.assignments ?? []).find(
      (assignment) => assignment.operationId === input.operationId,
    );
    if (existing !== undefined) {
      if (
        existing.parentSessionKey !== input.parentSessionKey ||
        existing.rootItemId !== input.rootItemId ||
        existing.provider !== input.provider ||
        existing.model !== input.model ||
        !sameResolvedSessionBinding(existing.binding, input.binding)
      ) {
        throw new Error(
          `Subagent operation '${input.operationId}' does not match its stored assignment`,
        );
      }
      return existing;
    }
    const sessionConflict = (list.assignments ?? []).find(
      (assignment) =>
        assignment.sessionKey === input.sessionKey ||
        assignment.threadId === input.threadId,
    );
    if (sessionConflict !== undefined) {
      throw new Error(
        "The subagent session or thread identity is already assigned",
      );
    }
    const storedToken = current.state.correlationTokens[input.sessionKey];
    if (storedToken !== undefined && storedToken !== input.correlationToken) {
      throw new Error("The subagent session has another correlation token");
    }
    todoSubtreeIds(list, input.rootItemId);
    const activeAssignments = (list.assignments ?? []).filter(
      (assignment) => assignment.status === "active",
    );
    const directParent = activeAssignments.find(
      (assignment) => assignment.sessionKey === input.parentSessionKey,
    );
    if (directParent !== undefined) {
      const parentSubtree = todoSubtreeIds(list, directParent.rootItemId);
      if (
        input.rootItemId === directParent.rootItemId ||
        !parentSubtree.has(input.rootItemId)
      ) {
        throw new Error(
          `Todo subtree '${input.rootItemId}' is outside the parent assignment`,
        );
      }
      if (input.depth !== directParent.depth + 1) {
        throw new Error(
          "The subagent depth does not follow its parent assignment",
        );
      }
    } else if (input.parentSessionKey !== list.sessionKey) {
      throw new Error(
        "The subagent parent is outside the todo assignment tree",
      );
    } else if (input.depth !== 1) {
      throw new Error("A top-level subagent assignment must have depth one");
    }
    const ancestors = assignmentAncestors(
      activeAssignments,
      input.parentSessionKey,
    );
    const conflict = activeAssignments.find(
      (assignment) =>
        !ancestors.has(assignment.sessionKey) &&
        assignmentsOverlap(list, assignment.rootItemId, input.rootItemId),
    );
    if (conflict !== undefined) {
      throw new Error(
        `Todo subtree '${input.rootItemId}' is already assigned to '${conflict.sessionKey}'`,
      );
    }
    const nextList: TodoList = {
      ...list,
      assignments: [...(list.assignments ?? []), candidate],
    };
    const todoState = current.state.todoState;
    if (!isTodoState(todoState)) throw new Error("Invalid todo state");
    const nextTodoState = {
      ...todoState,
      lists: todoState.lists.map((candidateList) =>
        candidateList.sessionKey === list.sessionKey ? nextList : candidateList,
      ),
    };
    if (!isTodoState(nextTodoState)) {
      throw new Error("The todo assignment would create invalid durable state");
    }
    const claimed = store.compareAndSwapInstance(
      input.instanceId,
      current.version,
      {
        ...current.state,
        correlationTokens: {
          ...current.state.correlationTokens,
          [input.sessionKey]: input.correlationToken,
        },
        todoState: nextTodoState,
      },
    );
    if (claimed !== undefined) return candidate;
  }
};

export const assignmentForChild = (
  record: InstanceRecord,
  sessionKey: string,
): { assignment: TodoAssignment; list: TodoList } => {
  if (!isTodoState(record.state.todoState)) {
    throw new Error("The workflow instance has no valid todo state");
  }
  const matches = record.state.todoState.lists.flatMap((list) =>
    (list.assignments ?? [])
      .filter((assignment) => assignment.sessionKey === sessionKey)
      .map((assignment) => ({ assignment, list })),
  );
  if (matches.length !== 1) {
    throw new Error(
      `Subagent session '${sessionKey}' is not bound to one todo assignment`,
    );
  }
  return matches[0]!;
};

export const mutateTodoAssignment = (
  store: DelegationStateStore,
  instanceId: string,
  sessionKey: string,
  mutate: (assignment: TodoAssignment) => TodoAssignment,
): TodoAssignment => {
  while (true) {
    const current = requireRecord(store, instanceId);
    const { assignment, list } = assignmentForChild(current, sessionKey);
    const next = mutate(assignment);
    for (const field of [
      "bootstrap",
      "binding",
      "correlationToken",
      "depth",
      "model",
      "operationId",
      "parentSessionKey",
      "parentThreadId",
      "provider",
      "rootItemId",
      "sessionKey",
      "threadId",
    ] as const) {
      if (JSON.stringify(next[field]) !== JSON.stringify(assignment[field])) {
        throw new Error(
          `Todo assignment identity field cannot change: ${field}`,
        );
      }
    }
    const todoState = current.state.todoState;
    if (!isTodoState(todoState)) throw new Error("Invalid todo state");
    const nextList: TodoList = {
      ...list,
      assignments: (list.assignments ?? []).map((candidate) =>
        candidate.sessionKey === sessionKey ? next : candidate,
      ),
    };
    const nextTodoState = {
      ...todoState,
      lists: todoState.lists.map((candidate) =>
        candidate.sessionKey === list.sessionKey ? nextList : candidate,
      ),
    };
    if (!isTodoState(nextTodoState)) {
      throw new Error("The todo assignment mutation is invalid");
    }
    const claimed = store.compareAndSwapInstance(instanceId, current.version, {
      ...current.state,
      todoState: nextTodoState,
    });
    if (claimed !== undefined) return next;
  }
};

export const replaceTodoAssignmentCandidate = (
  store: DelegationStateStore,
  instanceId: string,
  sessionKey: string,
  replacement: Pick<
    TodoAssignment,
    "binding" | "bootstrap" | "model" | "provider" | "threadId"
  >,
): TodoAssignment => {
  assertResolvedSessionBinding(
    replacement.binding,
    sessionKey,
    replacement.threadId,
  );
  if (
    replacement.binding.providerInstanceId !== replacement.provider ||
    replacement.binding.modelSlug !== replacement.model
  ) {
    throw new Error(
      "Replacement provider and model must match its resolved session binding",
    );
  }
  while (true) {
    const current = requireRecord(store, instanceId);
    const { assignment, list } = assignmentForChild(current, sessionKey);
    const currentBinding = assignment.binding;
    const nextBinding = replacement.binding;
    if (
      assignment.status !== "active" ||
      nextBinding.alias !== currentBinding.alias ||
      nextBinding.sessionKey !== currentBinding.sessionKey ||
      nextBinding.runtimeMode !== currentBinding.runtimeMode ||
      nextBinding.interactionMode !== currentBinding.interactionMode ||
      nextBinding.candidatePosition < currentBinding.candidatePosition
    ) {
      throw new Error("Replacement candidate changed delegated authority");
    }
    for (const skipped of currentBinding.skippedCandidates) {
      const retained = nextBinding.skippedCandidates.find(
        ({ candidatePosition }) =>
          candidatePosition === skipped.candidatePosition,
      );
      if (JSON.stringify(retained) !== JSON.stringify(skipped)) {
        throw new Error(
          "Replacement candidate discarded prior failure evidence",
        );
      }
    }
    if (
      nextBinding.candidatePosition > currentBinding.candidatePosition &&
      !nextBinding.skippedCandidates.some(
        ({ candidatePosition }) =>
          candidatePosition === currentBinding.candidatePosition,
      )
    ) {
      throw new Error("Replacement candidate omitted the failed predecessor");
    }
    if (
      nextBinding.candidatePosition === currentBinding.candidatePosition &&
      (replacement.provider !== assignment.provider ||
        replacement.model !== assignment.model ||
        replacement.threadId !== assignment.threadId ||
        JSON.stringify(replacement.bootstrap) !==
          JSON.stringify(assignment.bootstrap))
    ) {
      throw new Error("Same candidate cannot change delegated identity");
    }
    const todoState = current.state.todoState;
    if (!isTodoState(todoState)) throw new Error("Invalid todo state");
    if (
      todoState.lists
        .flatMap((candidateList) => candidateList.assignments ?? [])
        .some(
          (candidate) =>
            candidate.sessionKey !== sessionKey &&
            candidate.threadId === replacement.threadId,
        )
    ) {
      throw new Error("The replacement thread identity is already assigned");
    }
    const nextAssignment: TodoAssignment = {
      ...assignment,
      ...replacement,
    };
    const nextList: TodoList = {
      ...list,
      assignments: (list.assignments ?? []).map((candidate) =>
        candidate.sessionKey === sessionKey ? nextAssignment : candidate,
      ),
    };
    const nextTodoState = {
      ...todoState,
      lists: todoState.lists.map((candidate) =>
        candidate.sessionKey === list.sessionKey ? nextList : candidate,
      ),
    };
    if (!isTodoState(nextTodoState)) {
      throw new Error("The replacement candidate would create invalid state");
    }
    const replaced = store.compareAndSwapInstance(instanceId, current.version, {
      ...current.state,
      todoState: nextTodoState,
    });
    if (replaced !== undefined) return nextAssignment;
  }
};
