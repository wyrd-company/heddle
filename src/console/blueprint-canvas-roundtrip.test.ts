// ---
// relationships:
//   verifies: heddle
//   references: flowcraft-gate
// ---

import type { Editor, TLBinding, TLShape, TLShapeId } from "tldraw";
import { describe, expect, it } from "vitest";

import { blueprintToCanvas } from "../../spikes/flowcraft-gate/viewer/vendor/flowcraft-tldraw/sync/blueprint-to-canvas";
import { canvasToBlueprint } from "../../spikes/flowcraft-gate/viewer/vendor/flowcraft-tldraw/sync/canvas-to-blueprint";
import type { LifecycleBlueprint } from "../engine/index.js";

class FixtureCanvas {
  readonly bindings: TLBinding[] = [];
  readonly shapes: TLShape[] = [];

  createBinding(binding: Omit<TLBinding, "id" | "meta">): void {
    this.bindings.push({
      ...binding,
      id: `binding:${this.bindings.length}`,
      meta: {},
    } as TLBinding);
  }

  createShapes(shapes: TLShape[]): void {
    for (const shape of shapes) {
      const record = {
        index: "a1",
        isLocked: false,
        meta: {},
        opacity: 1,
        parentId: "page:page",
        rotation: 0,
        typeName: "shape",
        x: 0,
        y: 0,
        ...shape,
      } as TLShape;
      const existingIndex = this.shapes.findIndex(({ id }) => id === record.id);
      if (existingIndex === -1) this.shapes.push(record);
      else this.shapes.splice(existingIndex, 1, record);
    }
  }

  deleteShapes(ids: TLShapeId[]): void {
    const removed = new Set(ids);
    this.shapes.splice(
      0,
      this.shapes.length,
      ...this.shapes.filter(({ id }) => !removed.has(id)),
    );
  }

  getBindingsFromShape(shapeId: TLShapeId): TLBinding[] {
    return this.bindings.filter(({ fromId }) => fromId === shapeId);
  }

  getCurrentPageShapes(): TLShape[] {
    return this.shapes;
  }

  zoomToFit(): void {}
}

describe("blueprint canvas conversion", () => {
  it("round-trips the production node and edge extensions", () => {
    const canvas = new FixtureCanvas();
    const blueprint: LifecycleBlueprint = {
      id: "sample-process",
      nodes: [
        {
          id: "inspect",
          uses: "wait",
          tools: ["advance"],
          "todo-template": "sample-checklist",
        },
        { id: "finish", uses: "finish" },
      ],
      edges: [
        {
          condition: "result.output.dispositions.complete",
          description: "Continue after inspection",
          disposition: "complete",
          source: "inspect",
          target: "finish",
          transform: "result.output",
        },
      ],
    };

    blueprintToCanvas(
      canvas as unknown as Editor,
      {
        id: blueprint.id,
        nodes: blueprint.nodes.map(({ id, uses }) => ({ id, uses })),
        edges: blueprint.edges.map(({ condition, source, target }) => ({
          condition,
          source,
          target,
        })),
      },
      {
        positions: {
          finish: { x: 300, y: 20 },
          inspect: { x: 0, y: 20 },
        },
      },
    );
    blueprintToCanvas(canvas as unknown as Editor, blueprint, {
      positions: {
        finish: { x: 420, y: 60 },
        inspect: { x: 80, y: 120 },
      },
    });
    const roundTrip = canvasToBlueprint(canvas as unknown as Editor);

    expect(roundTrip.nodes).toEqual(blueprint.nodes);
    expect(roundTrip.edges).toEqual(blueprint.edges);
    expect(roundTrip.positions).toEqual({
      finish: { x: 420, y: 60 },
      inspect: { x: 80, y: 120 },
    });
  });

  it("keeps parallel edges distinct", () => {
    const canvas = new FixtureCanvas();
    const blueprint: LifecycleBlueprint = {
      id: "sample-process",
      nodes: [
        { id: "first", uses: "prepare" },
        { id: "second", uses: "finish" },
      ],
      edges: [
        {
          condition: "result.output.left",
          source: "first",
          target: "second",
        },
        {
          condition: "result.output.right",
          source: "first",
          target: "second",
        },
      ],
    };

    blueprintToCanvas(canvas as unknown as Editor, blueprint);

    expect(canvasToBlueprint(canvas as unknown as Editor).edges).toEqual(
      blueprint.edges,
    );
  });
});
