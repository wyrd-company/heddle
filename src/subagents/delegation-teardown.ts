// ---
// relationships:
//   implements: heddle
// ---

import type { InstanceRecord } from "../persistence/index.js";
import {
  isTodoState,
  type TodoAssignment,
  type TodoList,
} from "../todo/index.js";
import {
  assignmentForChild,
  type DelegationStateStore,
} from "./delegation-state.js";

const requireRecord = (
  store: Pick<DelegationStateStore, "getInstance">,
  instanceId: string,
): InstanceRecord => {
  const record = store.getInstance(instanceId);
  if (record === undefined)
    throw new Error(`Instance does not exist: ${instanceId}`);
  return record;
};

const assignmentDescendsFrom = (
  assignments: readonly TodoAssignment[],
  assignment: TodoAssignment,
  ancestorSessionKey: string,
): boolean => {
  const visited = new Set<string>();
  let parentSessionKey = assignment.parentSessionKey;
  while (true) {
    if (parentSessionKey === ancestorSessionKey) return true;
    if (visited.has(parentSessionKey)) return false;
    visited.add(parentSessionKey);
    const parent = assignments.find(
      ({ sessionKey }) => sessionKey === parentSessionKey,
    );
    if (parent === undefined) return false;
    parentSessionKey = parent.parentSessionKey;
  }
};

export const stopTodoAssignmentTree = (
  store: DelegationStateStore,
  instanceId: string,
  sessionKey: string,
  notification: NonNullable<TodoAssignment["stopNotification"]>,
):
  | {
      assignment: TodoAssignment;
      kind: "stopped-by-ancestor";
      stoppedSessionKeys: string[];
    }
  | {
      assignment: TodoAssignment;
      kind: "stopped-root";
      stoppedSessionKeys: string[];
    } => {
  while (true) {
    const current = requireRecord(store, instanceId);
    const { assignment, list } = assignmentForChild(current, sessionKey);
    const affected = (list.assignments ?? []).filter(
      (candidate) =>
        candidate.sessionKey === sessionKey ||
        assignmentDescendsFrom(list.assignments ?? [], candidate, sessionKey),
    );
    const stoppedSessionKeys = affected.map(
      ({ sessionKey: candidate }) => candidate,
    );
    if (assignment.status === "stopped") {
      return {
        assignment,
        kind:
          assignment.ancestorStop === undefined
            ? "stopped-root"
            : "stopped-by-ancestor",
        stoppedSessionKeys,
      };
    }
    const nextList: TodoList = {
      ...list,
      assignments: (list.assignments ?? []).map((candidate) => {
        if (candidate.sessionKey === sessionKey) {
          return {
            ...candidate,
            status: "stopped",
            stopNotification: notification,
          };
        }
        if (
          candidate.status === "active" &&
          assignmentDescendsFrom(list.assignments ?? [], candidate, sessionKey)
        ) {
          return {
            ...candidate,
            ancestorStop: {
              ancestorSessionKey: sessionKey,
              createdAt: notification.createdAt,
            },
            status: "stopped",
          };
        }
        return candidate;
      }),
    };
    const todoState = current.state.todoState;
    if (!isTodoState(todoState)) throw new Error("Invalid todo state");
    const nextTodoState = {
      ...todoState,
      lists: todoState.lists.map((candidate) =>
        candidate.sessionKey === list.sessionKey ? nextList : candidate,
      ),
    };
    if (!isTodoState(nextTodoState)) {
      throw new Error("The todo assignment teardown is invalid");
    }
    const claimed = store.compareAndSwapInstance(instanceId, current.version, {
      ...current.state,
      todoState: nextTodoState,
    });
    if (claimed !== undefined) {
      return {
        assignment: assignmentForChild(claimed, sessionKey).assignment,
        kind: "stopped-root",
        stoppedSessionKeys,
      };
    }
  }
};
