// ---
// relationships:
//   implements: heddle
// ---

import type {
  InstanceRecord,
  InstanceState,
  JsonValue,
} from "../persistence/index.js";
import {
  emptyTodoState,
  instantiateTodoList,
  isTodoState,
} from "./todo-template.js";
import type { TodoList, TodoState } from "./types.js";

export interface TodoStateStore {
  compareAndSwapInstance(
    instanceId: string,
    expectedVersion: number,
    state: InstanceState,
  ): InstanceRecord | undefined;
  getInstance(instanceId: string): InstanceRecord | undefined;
}

export type EnsureStageTodoListInput = {
  instanceId: string;
  repositoryRoot: string;
  sessionKey: string;
  stage: string;
  taskContract: JsonValue;
  templateId: string;
};

export const stageTodoList = (
  record: InstanceRecord,
  sessionKey: string,
  stage: string,
): { list: TodoList; state: TodoState } => {
  if (!isTodoState(record.state.todoState)) {
    throw new Error("The workflow instance has no valid todo state");
  }
  const list = record.state.todoState.lists.find(
    (candidate) => candidate.sessionKey === sessionKey,
  );
  if (list === undefined || list.stage !== stage) {
    throw new Error("The stage session has no bound todo list");
  }
  return { list, state: record.state.todoState };
};

export const stageTodoStateForHandoff = (
  record: InstanceRecord,
  sessionKey: string,
  stage: string,
  storedHandoffSessionKeys: readonly string[],
): { list: TodoList; state: TodoState } => {
  const { list, state } = stageTodoList(record, sessionKey, stage);
  const eligibleSessionKeys = new Set([
    ...storedHandoffSessionKeys,
    sessionKey,
  ]);
  return {
    list,
    state: {
      ...state,
      lists: state.lists.filter((candidate) =>
        eligibleSessionKeys.has(candidate.sessionKey),
      ),
    },
  };
};

export const mutateStageTodoList = (
  store: TodoStateStore,
  input: { instanceId: string; sessionKey: string; stage: string },
  mutate: (list: TodoList) => TodoList,
): TodoList => {
  while (true) {
    const current = store.getInstance(input.instanceId);
    if (current === undefined)
      throw new Error("The workflow instance is absent");
    const { list, state } = stageTodoList(
      current,
      input.sessionKey,
      input.stage,
    );
    const nextList = mutate(list);
    const nextState: TodoState = {
      ...state,
      lists: state.lists.map((candidate) =>
        candidate.sessionKey === list.sessionKey ? nextList : candidate,
      ),
    };
    const claimed = store.compareAndSwapInstance(
      current.instanceId,
      current.version,
      { ...current.state, todoState: nextState },
    );
    if (claimed !== undefined) return nextList;
  }
};

export const ensureStageTodoList = async (
  store: TodoStateStore,
  input: EnsureStageTodoListInput,
  instantiate: typeof instantiateTodoList = instantiateTodoList,
): Promise<TodoState> => {
  let candidate: TodoList | undefined;
  while (true) {
    const current = store.getInstance(input.instanceId);
    if (current === undefined) {
      throw new Error(`Instance does not exist: ${input.instanceId}`);
    }
    const todoState =
      current.state.todoState === null
        ? emptyTodoState()
        : isTodoState(current.state.todoState)
          ? current.state.todoState
          : undefined;
    if (todoState === undefined) {
      throw new TypeError(
        `Instance '${input.instanceId}' has invalid todo state`,
      );
    }
    const existing = todoState.lists.find(
      ({ sessionKey }) => sessionKey === input.sessionKey,
    );
    if (existing !== undefined) {
      if (
        existing.stage !== input.stage ||
        existing.template !== input.templateId
      ) {
        throw new Error(
          `Stored todo list does not match stage contract for '${input.sessionKey}'`,
        );
      }
      return todoState;
    }

    candidate ??= await instantiate({
      repositoryRoot: input.repositoryRoot,
      sessionKey: input.sessionKey,
      stage: input.stage,
      taskContract: input.taskContract,
      templateId: input.templateId,
    });
    const nextTodoState: TodoState = {
      ...todoState,
      lists: [...todoState.lists, candidate],
    };
    const claimed = store.compareAndSwapInstance(
      input.instanceId,
      current.version,
      { ...current.state, todoState: nextTodoState },
    );
    if (claimed !== undefined) return nextTodoState;
  }
};
