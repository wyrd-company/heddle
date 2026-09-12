// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import {
  lifecycleCanvasPositions,
  MIN_READABLE_NODE_SCALE,
  MIN_READABLE_NODE_WIDTH,
} from "./lifecycle-canvas-layout.js";

describe("lifecycle canvas layout", () => {
  it("orders a realistic cyclic graph by its edges in a compact three-column path", () => {
    const nodes = [
      "finish",
      "inspect",
      "arrange",
      "survey",
      "refine",
      "catalogue",
      "plan",
      "prepare",
    ].map((id) => ({ id }));
    const edges = [
      { source: "survey", target: "catalogue" },
      { source: "catalogue", target: "plan" },
      { source: "plan", target: "prepare" },
      { source: "prepare", target: "arrange" },
      { source: "arrange", target: "inspect" },
      { source: "inspect", target: "finish" },
      { source: "inspect", target: "refine" },
      { source: "refine", target: "arrange" },
    ];

    expect(lifecycleCanvasPositions(nodes, edges)).toEqual({
      survey: { x: 0, y: 0 },
      catalogue: { x: 300, y: 0 },
      plan: { x: 600, y: 0 },
      prepare: { x: 600, y: 220 },
      arrange: { x: 300, y: 220 },
      inspect: { x: 0, y: 220 },
      finish: { x: 0, y: 440 },
      refine: { x: 300, y: 440 },
    });
  });

  it("retains every node when a component has no root", () => {
    const nodes = ["one", "two", "three"].map((id) => ({ id }));

    expect(
      Object.keys(
        lifecycleCanvasPositions(nodes, [
          { source: "one", target: "two" },
          { source: "two", target: "one" },
        ]),
      ),
    ).toEqual(["three", "one", "two"]);
  });

  it("defines the readable card-width agreement", () => {
    expect(MIN_READABLE_NODE_SCALE).toBe(0.8);
    expect(MIN_READABLE_NODE_WIDTH).toBe(176);
  });
});
