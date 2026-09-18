// ---
// relationships:
//   implements: github-binding-and-intake
// ---
import type { Blueprint } from "../blueprints/types.js";
import { supportsNodeType } from "../engine/node-capabilities.js";
import type { EngineNode } from "../engine/types.js";

export function assertRuntimeCapabilities(
  blueprints: readonly Blueprint[],
  nodes: Readonly<Record<string, EngineNode>>,
  notificationsConfigured: boolean,
): void {
  const unavailable = blueprints.flatMap((blueprint) =>
    Object.entries(blueprint.nodes).flatMap(([nodeId, node]) => {
      if (supportsNodeType(nodes, node.uses)) return [];
      const remedy =
        node.uses === "notify" && !notificationsConfigured
          ? "configure options.notifications to enable notification delivery"
          : `register a runtime implementation for node type "${node.uses}"`;
      return [
        `blueprint "${blueprint.id}", node "${nodeId}": node type "${node.uses}" is unavailable; ${remedy}`,
      ];
    }),
  );
  if (unavailable.length > 0)
    throw new Error(
      `Blueprint runtime capability check failed:\n- ${unavailable.join("\n- ")}`,
    );
}
