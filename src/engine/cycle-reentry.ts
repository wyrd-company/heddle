// ---
// relationships:
//   implements: engine-and-run-model
//   references: flowcraft-stage-semantics
// ---
import type { GraphTraverser } from "flowcraft";

/** Flowcraft suppresses completed targets except its action-edge loop controller.
 * Heddle's condition edges select another visit explicitly. Reset only selected
 * targets with a return path, preserving ordinary completed joins.
 */
export function enableCycleReentry(traverser: GraphTraverser): void {
  const reaches = (
    from: string,
    target: string,
    visited = new Set<string>(),
  ): boolean => {
    if (from === target) return true;
    if (visited.has(from)) return false;
    visited.add(from);
    return [...traverser.getSuccessors(from)].some((next) =>
      reaches(next, target, visited),
    );
  };
  const complete = traverser.markNodeCompleted.bind(traverser);
  traverser.markNodeCompleted = (source, result, next) => {
    for (const target of next) {
      if (target.id !== source && reaches(target.id, source))
        traverser.resetNodeCompletion(target.id);
    }
    complete(source, result, next);
    // Completion re-adds the source before Flowcraft examines its successors.
    if (next.some((target) => target.id === source))
      traverser.addToFrontier(source);
  };
}
