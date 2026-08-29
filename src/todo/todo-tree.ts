// ---
// relationships:
//   implements: heddle
// ---

import type { TodoItem, TodoList } from "./types.js";

export const validTodoTree = (items: readonly TodoItem[]): boolean => {
  const byId = new Map(items.map((item) => [item.id, item]));
  if (byId.size !== items.length) return false;
  for (const item of items) {
    if (item.parentId !== undefined && !byId.has(item.parentId)) return false;
    const visited = new Set<string>();
    let current: TodoItem | undefined = item;
    while (current?.parentId !== undefined) {
      if (visited.has(current.id)) return false;
      visited.add(current.id);
      current = byId.get(current.parentId);
      if (current === undefined) return false;
    }
  }
  return true;
};

export const todoSubtreeIds = (
  list: TodoList,
  rootItemId: string,
): ReadonlySet<string> => {
  if (!list.items.some(({ id }) => id === rootItemId)) {
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

export const scopedTodoItems = (
  list: TodoList,
  rootItemId: string,
): TodoItem[] => {
  const allowed = todoSubtreeIds(list, rootItemId);
  return list.items.filter((item) => allowed.has(item.id));
};
