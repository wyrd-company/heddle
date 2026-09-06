// ---
// relationships:
//   implements: heddle
//   references: flowcraft-gate
// ---

export const LIFECYCLE_NODE_WIDTH = 220;
export const MIN_READABLE_NODE_SCALE = 0.8;
export const MIN_READABLE_NODE_WIDTH =
  LIFECYCLE_NODE_WIDTH * MIN_READABLE_NODE_SCALE;

const COLUMN_GAP = 300;
const ROW_GAP = 220;
const MAX_COLUMNS = 3;

interface LifecycleGraphNode {
  id: string;
}

interface LifecycleGraphEdge {
  source: string;
  target: string;
}

export const lifecycleCanvasPositions = (
  nodes: readonly LifecycleGraphNode[],
  edges: readonly LifecycleGraphEdge[],
): Record<string, { x: number; y: number }> => {
  const nodeIds = new Set(nodes.map(({ id }) => id));
  const incoming = new Map(nodes.map(({ id }) => [id, 0]));
  const outgoing = new Map(nodes.map(({ id }) => [id, [] as string[]]));

  for (const { source, target } of edges) {
    if (!nodeIds.has(source) || !nodeIds.has(target)) continue;
    outgoing.get(source)?.push(target);
    incoming.set(target, (incoming.get(target) ?? 0) + 1);
  }

  const queued = new Set<string>();
  const ordered: string[] = [];
  const queue: string[] = [];
  const enqueue = (id: string) => {
    if (queued.has(id)) return;
    queued.add(id);
    queue.push(id);
  };
  const drain = () => {
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) break;
      ordered.push(id);
      for (const target of outgoing.get(id) ?? []) enqueue(target);
    }
  };

  for (const { id } of nodes) {
    if (incoming.get(id) === 0) enqueue(id);
  }
  drain();
  for (const { id } of nodes) {
    enqueue(id);
    drain();
  }

  return Object.fromEntries(
    ordered.map((id, index) => {
      const row = Math.floor(index / MAX_COLUMNS);
      const offset = index % MAX_COLUMNS;
      const column = row % 2 === 0 ? offset : MAX_COLUMNS - offset - 1;
      return [id, { x: column * COLUMN_GAP, y: row * ROW_GAP }];
    }),
  );
};
