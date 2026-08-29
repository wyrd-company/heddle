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
