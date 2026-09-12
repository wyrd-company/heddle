// ---
// relationships:
//   implements: heddle
// ---

import type { TodoAssignment, TodoList } from "../todo/index.js";

export const requireActiveAssignmentLineage = (
  list: TodoList,
  sessionKey: string,
): TodoAssignment => {
  const assignments = list.assignments ?? [];
  const assignment = assignments.find(
    (candidate) => candidate.sessionKey === sessionKey,
  );
  if (assignment === undefined || assignment.status !== "active") {
    throw new Error("The subagent todo assignment is not active");
  }
  const visited = new Set<string>();
  let current = assignment;
  while (current.parentSessionKey !== list.sessionKey) {
    if (visited.has(current.sessionKey)) {
      throw new Error("The subagent todo assignment lineage is cyclic");
    }
    visited.add(current.sessionKey);
    const parent = assignments.find(
      (candidate) => candidate.sessionKey === current.parentSessionKey,
    );
    if (parent === undefined || parent.status !== "active") {
      throw new Error("The subagent todo assignment ancestor is not active");
    }
    current = parent;
  }
  return assignment;
};
