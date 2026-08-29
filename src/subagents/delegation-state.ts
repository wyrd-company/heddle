// ---
// relationships:
//   implements: heddle
// ---

import type { InstanceRecord, InstanceState } from "../persistence/index.js";
import { isTodoState } from "../todo/index.js";
import type { TodoAssignment, TodoItem, TodoList } from "../todo/types.js";

export interface DelegationStateStore {
  compareAndSwapInstance(
    instanceId: string,
    expectedVersion: number,
    state: InstanceState,
  ): InstanceRecord | undefined;
  getInstance(instanceId: string): InstanceRecord | undefined;
  listInstances(): InstanceRecord[];
}

export type ClaimTodoAssignmentInput = {
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

export const todoSubtreeIds = (
  list: TodoList,
  rootItemId: string,
): ReadonlySet<string> => {
  const byId = new Map(list.items.map((item) => [item.id, item]));
  if (!byId.has(rootItemId)) {
    throw new Error(`Todo item does not exist: ${rootItemId}`);
  }
  const descendants = new Set<string>([rootItemId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of list.items) {
      if (
        item.parentId !== undefined &&
        descendants.has(item.parentId) &&
        !descendants.has(item.id)
      ) {
        descendants.add(item.id);
        changed = true;
      }
    }
  }
  return descendants;
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

const tokenIsGloballyAvailable = (
  store: Pick<DelegationStateStore, "listInstances">,
  token: string,
  instanceId: string,
  sessionKey: string,
): boolean =>
  store
    .listInstances()
    .every((record) =>
      Object.entries(record.state.correlationTokens).every(
        ([candidateSession, candidateToken]) =>
          candidateToken !== token ||
          (record.instanceId === instanceId && candidateSession === sessionKey),
      ),
    );

export const claimTodoAssignment = (
  store: DelegationStateStore,
  input: ClaimTodoAssignmentInput,
): TodoAssignment => {
  const candidate: TodoAssignment = {
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
        existing.model !== input.model
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
    if (
      !tokenIsGloballyAvailable(
        store,
        input.correlationToken,
        input.instanceId,
        input.sessionKey,
      )
    ) {
      throw new Error("The subagent correlation token is already assigned");
    }
    const nextList: TodoList = {
      ...list,
      assignments: [...(list.assignments ?? []), candidate],
    };
    const todoState = current.state.todoState;
    if (!isTodoState(todoState)) throw new Error("Invalid todo state");
    const claimed = store.compareAndSwapInstance(
      input.instanceId,
      current.version,
      {
        ...current.state,
        correlationTokens: {
          ...current.state.correlationTokens,
          [input.sessionKey]: input.correlationToken,
        },
        todoState: {
          ...todoState,
          lists: todoState.lists.map((candidateList) =>
            candidateList.sessionKey === list.sessionKey
              ? nextList
              : candidateList,
          ),
        },
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

export const scopedTodoItems = (
  list: TodoList,
  rootItemId: string,
): TodoItem[] => {
  const allowed = todoSubtreeIds(list, rootItemId);
  return list.items.filter((item) => allowed.has(item.id));
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
    const todoState = current.state.todoState;
    if (!isTodoState(todoState)) throw new Error("Invalid todo state");
    const nextList: TodoList = {
      ...list,
      assignments: (list.assignments ?? []).map((candidate) =>
        candidate.sessionKey === sessionKey ? next : candidate,
      ),
    };
    const claimed = store.compareAndSwapInstance(instanceId, current.version, {
      ...current.state,
      todoState: {
        ...todoState,
        lists: todoState.lists.map((candidate) =>
          candidate.sessionKey === list.sessionKey ? nextList : candidate,
        ),
      },
    });
    if (claimed !== undefined) return next;
  }
};
