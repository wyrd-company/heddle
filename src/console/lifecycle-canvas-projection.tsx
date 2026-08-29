// ---
// relationships:
//   implements: heddle
//   references: flowcraft-gate
// ---

import type { Editor, TLShapeId } from "tldraw";

import {
  FLOWCRAFT_NODE,
  type FlowcraftNodeShape,
  type NodeStatus,
} from "../../spikes/flowcraft-gate/viewer/vendor/flowcraft-tldraw/shapes/types";
import type { ConsoleLifecycleSnapshot } from "./types.js";

export const projectLifecycleCanvas = (
  editor: Editor,
  snapshot: ConsoleLifecycleSnapshot,
): void => {
  const current = new Set(snapshot.currentStageIds);
  const replayed = new Map<
    string,
    { nodeData: Record<string, unknown>; status: NodeStatus }
  >();
  for (const event of snapshot.events) {
    if (
      typeof event.payload !== "object" ||
      event.payload === null ||
      Array.isArray(event.payload) ||
      typeof event.payload["nodeId"] !== "string"
    ) {
      continue;
    }
    const previous = replayed.get(event.payload["nodeId"]);
    const status: NodeStatus | undefined =
      event.type === "node:start"
        ? "pending"
        : event.type === "node:finish"
          ? "completed"
          : event.type === "node:error"
            ? "failed"
            : undefined;
    if (status === undefined) continue;
    const nodeData = { ...previous?.nodeData };
    if (event.type === "node:start") nodeData.inputs = event.payload["input"];
    if (event.type === "node:finish") {
      const result = event.payload["result"];
      if (
        typeof result === "object" &&
        result !== null &&
        !Array.isArray(result)
      ) {
        nodeData.outputs = result["output"];
      }
    }
    if (event.type === "node:error") nodeData.error = event.payload["error"];
    replayed.set(event.payload["nodeId"], { nodeData, status });
  }
  const shapes: FlowcraftNodeShape[] = [];
  for (const { id } of snapshot.blueprint.nodes) {
    const shape = editor.getShape<FlowcraftNodeShape>(
      `shape:${id}` as TLShapeId,
    );
    if (shape?.type !== FLOWCRAFT_NODE) continue;
    const state = replayed.get(id);
    shapes.push({
      ...shape,
      props: {
        ...shape.props,
        nodeData: state?.nodeData,
        status: current.has(id) ? "pending" : (state?.status ?? "idle"),
      },
    });
  }
  editor.store.mergeRemoteChanges(() => editor.store.put(shapes));
};
