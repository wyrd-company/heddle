// ---
// relationships:
//   implements: heddle
// ---

import type {
  ConsoleLifecycleEvent,
  ConsoleLifecycleSnapshot,
} from "./types.js";

export const lifecycleTraversalCounts = (
  events: ConsoleLifecycleEvent[],
): Array<{ count: number; nodeId: string }> => {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (
      event.type !== "node:start" ||
      typeof event.payload !== "object" ||
      event.payload === null ||
      Array.isArray(event.payload) ||
      typeof event.payload["nodeId"] !== "string"
    ) {
      continue;
    }
    const nodeId = event.payload["nodeId"];
    counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([nodeId, count]) => ({ count, nodeId }));
};

export const assertLifecycleReplacement = (
  snapshot: ConsoleLifecycleSnapshot,
): void => {
  snapshot.events.forEach(({ sequence }, index) => {
    if (sequence !== index + 1) {
      throw new Error("Lifecycle replay is not contiguous from sequence one");
    }
  });
  if (snapshot.nextSequence !== snapshot.events.length) {
    throw new Error("Lifecycle replay cursor disagrees with event history");
  }
};

export const appendLifecycleSnapshot = (
  current: ConsoleLifecycleSnapshot,
  next: ConsoleLifecycleSnapshot,
): ConsoleLifecycleSnapshot => {
  if (
    current.instanceId !== next.instanceId ||
    current.taskId !== next.taskId ||
    current.blueprint.blobHash !== next.blueprint.blobHash
  ) {
    throw new Error("Lifecycle tail identity disagrees with replayed history");
  }
  next.events.forEach(({ sequence }, index) => {
    if (sequence !== current.nextSequence + index + 1) {
      throw new Error("Lifecycle tail is not contiguous");
    }
  });
  const expectedCursor =
    next.events.length === 0
      ? current.nextSequence
      : next.events[next.events.length - 1]!.sequence;
  if (next.nextSequence !== expectedCursor) {
    throw new Error("Lifecycle tail cursor disagrees with event history");
  }
  return { ...next, events: [...current.events, ...next.events] };
};
